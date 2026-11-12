import { randomUUID } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrationsFolder } from '../src/scripts/migrate';
import { testDatabaseName } from '../src/testing';

/**
 * The app-draws migration (ADR 0024, odd/tasks/owner-feedback-2026-11-11b.md,
 * T9) on a database that already holds awards: it only adds. Existing awards
 * keep their rows and come from no in-app draw; the new record table has its
 * tenant policy and is append-only. Found by its tag.
 */
const adminUrl = process.env.TEST_DATABASE_ADMIN_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const name = testDatabaseName('sortea_test_db_migration_app_draws');
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
	if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`Invalid test database name ${name}`);
	await admin(`drop database if exists ${name} with (force)`);
	await admin(`create database ${name}`);
	// The migrations before the app-draws one only: the journal is cut there.
	scratch = mkdtempSync(join(tmpdir(), 'sortea-migration-'));
	cpSync(migrationsFolder, scratch, { recursive: true });
	const journalPath = join(scratch, 'meta', '_journal.json');
	const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { idx: number; tag: string }[] };
	const target = journal.entries.find((entry) => entry.tag.endsWith('_app_draws'));
	if (!target) throw new Error('The app_draws migration is not in the journal');
	writeFileSync(journalPath, JSON.stringify({ ...journal, entries: journal.entries.filter((entry) => entry.idx < target.idx) }));
	await migrateWith(scratch);
});

afterAll(async () => {
	if (scratch) rmSync(scratch, { recursive: true, force: true });
	await admin(`drop database if exists ${name} with (force)`);
});

describe('migration app_draws', () => {
	it('keeps existing awards as they are, from no in-app draw, and adds a protected, append-only record table', async () => {
		const ids = { org: randomUUID(), campaign: randomUUID(), prize: randomUUID(), award: randomUUID() };
		const sql = postgres(url, { max: 1, onnotice: () => {} });
		try {
			await sql`insert into app.organizations (id, slug, name, order_prefix, settings) values (${ids.org}, ${`m-${ids.org.slice(0, 8)}`}, 'M', 'MM', ${sql.json({})})`;
			await sql`insert into app.campaigns (id, organization_id, slug, title, summary, timezone, opens_at, closes_at)
				values (${ids.campaign}, ${ids.org}, 'c', 'C', 'S', 'UTC', now(), now() + interval '1 day')`;
			await sql`insert into app.prizes (id, organization_id, campaign_id, position, kind, title, declared_value_minor)
				values (${ids.prize}, ${ids.org}, ${ids.campaign}, 1, 'vehicle', 'Moto', 100)`;
			await sql`insert into app.prize_awards (id, organization_id, campaign_id, prize_id, slot, role, rank, notes)
				values (${ids.award}, ${ids.org}, ${ids.campaign}, ${ids.prize}, 1, 'winner', 1, 'Extracto 3.º de la Quiniela')`;
		} finally {
			await sql.end();
		}

		await migrateWith(migrationsFolder);

		const after = postgres(url, { max: 1, onnotice: () => {} });
		try {
			const [award] = await after`select id, notes, app_draw_id from app.prize_awards where id = ${ids.award}`;
			expect(award).toEqual({ id: ids.award, notes: 'Extracto 3.º de la Quiniela', app_draw_id: null });
			const [table] = await after`select relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
				where n.nspname = 'app' and c.relname = 'app_draws'`;
			expect(table).toEqual({ relrowsecurity: true });
			const policies = await after`select policyname from pg_policies where schemaname = 'app' and tablename = 'app_draws'`;
			expect(policies.map((row) => row.policyname)).toEqual(['tenant_isolation']);
			const triggers = await after`select tgname from pg_trigger where tgrelid = 'app.app_draws'::regclass and not tgisinternal`;
			expect(triggers.map((row) => row.tgname)).toEqual(['app_draws_append_only']);

			const [draw] = await after`insert into app.app_draws (organization_id, campaign_id, candidate_sha256, candidate_count, candidates, picks, drawn_at)
				values (${ids.org}, ${ids.campaign}, ${'a'.repeat(64)}, 1, ${[7]}, ${after.json([])}, now()) returning id`;
			await after`update app.prize_awards set app_draw_id = ${draw!.id} where id = ${ids.award}`;
			await expect(after`update app.app_draws set candidate_count = 2`).rejects.toThrow(/append-only/);
			await expect(after`delete from app.app_draws`).rejects.toThrow(/append-only/);
		} finally {
			await after.end();
		}
	});
});
