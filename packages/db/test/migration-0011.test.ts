import { randomUUID } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrationsFolder } from '../src/scripts/migrate';

/**
 * Migration 0011 (ADR 0014 §2-§3) on a database that already holds prizes:
 * they stay manual, and the new draw record is tenant-isolated and append-only.
 */
const adminUrl = process.env.TEST_DATABASE_ADMIN_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const name = 'sortea_test_db_migration_0011';
const url = Object.assign(new URL(adminUrl), { pathname: `/${name}` }).toString();
let scratch: string;

async function admin(statement: string) {
	const client = postgres(adminUrl, { max: 1, onnotice: () => {} });
	try {
		await client.unsafe(statement);
	} finally {
		await client.end();
	}
}

async function migrateWith(folder: string) {
	const client = postgres(url, { max: 1, onnotice: () => {} });
	try {
		await migrate(drizzle(client), { migrationsFolder: folder, migrationsSchema: 'app', migrationsTable: '__migrations' });
	} finally {
		await client.end();
	}
}

beforeAll(async () => {
	await admin(`drop database if exists ${name} with (force)`);
	await admin(`create database ${name}`);
	// The migrations up to 0010 only: the journal is cut before 0011.
	scratch = mkdtempSync(join(tmpdir(), 'sortea-migration-'));
	cpSync(migrationsFolder, scratch, { recursive: true });
	const journalPath = join(scratch, 'meta', '_journal.json');
	const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { idx: number }[] };
	writeFileSync(journalPath, JSON.stringify({ ...journal, entries: journal.entries.filter((entry) => entry.idx <= 10) }));
	await migrateWith(scratch);
});

afterAll(async () => {
	if (scratch) rmSync(scratch, { recursive: true, force: true });
	await admin(`drop database if exists ${name} with (force)`);
});

describe('migration 0011 quiniela draws', () => {
	it('keeps existing prizes manual and protects the draw record', async () => {
		const ids = { org: randomUUID(), campaign: randomUUID(), prize: randomUUID() };
		const sql = postgres(url, { max: 1, onnotice: () => {} });
		try {
			await sql`insert into app.organizations (id, slug, name, order_prefix, settings) values (${ids.org}, ${`m-${ids.org.slice(0, 8)}`}, 'M', 'MM', ${sql.json({})})`;
			await sql`insert into app.campaigns (id, organization_id, slug, title, summary, timezone, opens_at, closes_at)
				values (${ids.campaign}, ${ids.org}, 'c', 'C', 'S', 'UTC', now(), now() + interval '1 day')`;
			await sql`insert into app.prizes (id, organization_id, campaign_id, position, kind, title, declared_value_minor)
				values (${ids.prize}, ${ids.org}, ${ids.campaign}, 1, 'vehicle', 'Moto', 100)`;
		} finally {
			await sql.end();
		}

		await migrateWith(migrationsFolder);

		const after = postgres(url, { max: 1, onnotice: () => {} });
		try {
			const [prize] = await after`select mechanism from app.prizes where id = ${ids.prize}`;
			expect(prize).toEqual({ mechanism: 'manual' });
			const [table] = await after`select relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
				where n.nspname = 'app' and c.relname = 'quiniela_draws'`;
			expect(table).toEqual({ relrowsecurity: true });
			const policies = await after`select policyname from pg_policies where schemaname = 'app' and tablename = 'quiniela_draws'`;
			expect(policies.map((row) => row.policyname)).toEqual(['tenant_isolation']);
			const triggers = await after`select tgname from pg_trigger where tgrelid = 'app.quiniela_draws'::regclass and not tgisinternal`;
			expect(triggers.map((row) => row.tgname)).toEqual(['quiniela_draws_append_only']);

			// The trigger is live: a stored draw cannot be rewritten or removed.
			const extracts = Array.from({ length: 20 }, (_, index) => index);
			await after`insert into app.quiniela_draws (organization_id, campaign_id, source, drawn_at, extracts, evidence_url, manifest_sha256)
				values (${ids.org}, ${ids.campaign}, 'Quiniela', now(), ${extracts}, 'https://example.com/x', ${'a'.repeat(64)})`;
			await expect(after`update app.quiniela_draws set source = 'Otra'`).rejects.toThrow(/append-only/);
			await expect(after`delete from app.quiniela_draws`).rejects.toThrow(/append-only/);
		} finally {
			await after.end();
		}
	});
});
