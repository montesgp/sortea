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
 * Migration 0012 (ADR 0014 §5) on a database that already holds a closed
 * campaign: everything recorded so far belongs to round 1, and a campaign
 * gets one manifest per round instead of one in total. The manifest and the
 * public log keep their protection.
 */
const adminUrl = process.env.TEST_DATABASE_ADMIN_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const name = 'sortea_test_db_migration_0012';
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
	// The migrations up to 0011 only: the journal is cut before 0012.
	scratch = mkdtempSync(join(tmpdir(), 'sortea-migration-'));
	cpSync(migrationsFolder, scratch, { recursive: true });
	const journalPath = join(scratch, 'meta', '_journal.json');
	const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { idx: number }[] };
	writeFileSync(journalPath, JSON.stringify({ ...journal, entries: journal.entries.filter((entry) => entry.idx <= 11) }));
	await migrateWith(scratch);
});

afterAll(async () => {
	if (scratch) rmSync(scratch, { recursive: true, force: true });
	await admin(`drop database if exists ${name} with (force)`);
});

describe('migration 0012 rounds', () => {
	it('puts existing records in round 1 and allows one manifest per round', async () => {
		const ids = { org: randomUUID(), campaign: randomUUID(), prize: randomUUID(), manifest: randomUUID() };
		const sql = postgres(url, { max: 1, onnotice: () => {} });
		try {
			await sql`insert into app.organizations (id, slug, name, order_prefix, settings) values (${ids.org}, ${`m-${ids.org.slice(0, 8)}`}, 'M', 'MM', ${sql.json({})})`;
			await sql`insert into app.campaigns (id, organization_id, slug, title, summary, status, timezone, opens_at, closes_at)
				values (${ids.campaign}, ${ids.org}, 'c', 'C', 'S', 'awarding', 'UTC', now() - interval '2 day', now() - interval '1 day')`;
			await sql`insert into app.prizes (id, organization_id, campaign_id, position, kind, title, declared_value_minor, mechanism)
				values (${ids.prize}, ${ids.org}, ${ids.campaign}, 1, 'vehicle', 'Moto', 100, 'quiniela')`;
			await sql`insert into app.draw_manifests (id, organization_id, campaign_id, rule_version, sha256, content, eligible_count, void_count, closed_at, published_at)
				values (${ids.manifest}, ${ids.org}, ${ids.campaign}, 1, ${'a'.repeat(64)}, 'v1', 0, 0, now() - interval '1 day', now())`;
			await sql`insert into app.draw_events (organization_id, campaign_id, kind, title, occurred_at) values (${ids.org}, ${ids.campaign}, 'result_published', 'Resultados', now())`;
			await sql`insert into app.prize_awards (organization_id, campaign_id, prize_id, slot, role, rank) values (${ids.org}, ${ids.campaign}, ${ids.prize}, 1, 'winner', 1)`;
		} finally {
			await sql.end();
		}

		await migrateWith(migrationsFolder);

		const after = postgres(url, { max: 1, onnotice: () => {} });
		try {
			expect(await after`select current_round from app.campaigns where id = ${ids.campaign}`).toEqual([{ current_round: 1 }]);
			expect(await after`select round from app.draw_manifests where campaign_id = ${ids.campaign}`).toEqual([{ round: 1 }]);
			expect(await after`select round from app.draw_events where campaign_id = ${ids.campaign}`).toEqual([{ round: 1 }]);
			expect(await after`select round from app.prize_awards where campaign_id = ${ids.campaign}`).toEqual([{ round: 1 }]);

			const indexes = await after`select indexname from pg_indexes where schemaname = 'app' and tablename = 'draw_manifests' and indexname <> 'draw_manifests_pkey' order by indexname`;
			expect(indexes.map((row) => row.indexname)).toEqual(['draw_manifests_round_uq']);
			// A second round gets its own manifest; a round never gets two.
			const manifest = (round: number) =>
				after`insert into app.draw_manifests (organization_id, campaign_id, round, rule_version, sha256, content, eligible_count, void_count, closed_at, published_at)
					values (${ids.org}, ${ids.campaign}, ${round}, 1, ${'b'.repeat(64)}, 'v2', 0, 0, now(), now())`;
			await manifest(2);
			await expect(manifest(2)).rejects.toThrow(/draw_manifests_round_uq/);
			await expect(manifest(0)).rejects.toThrow(/draw_manifests_round_check/);
			await expect(after`update app.campaigns set current_round = 0 where id = ${ids.campaign}`).rejects.toThrow(/campaigns_current_round_check/);

			// The protections are unchanged: a published manifest and the public log cannot be rewritten.
			await expect(after`update app.draw_manifests set content = 'x' where id = ${ids.manifest}`).rejects.toThrow(/immutable/);
			await expect(after`update app.draw_events set round = 2`).rejects.toThrow(/append-only/);
		} finally {
			await after.end();
		}
	});
});
