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
 * The draw-room migration (odd/tasks/draw-room.md T2, T3) on a database at
 * 0025 that already holds a campaign, an award and a stored one-shot in-app
 * draw: it only adds. The campaign keeps today's award order, the award and
 * the one-shot draw stay as they are, and the per-unit tiradas get a protected,
 * append-only table. Found by its tag.
 */
const adminUrl = process.env.TEST_DATABASE_ADMIN_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const name = testDatabaseName('sortea_test_db_migration_draw_room');
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
	// The migrations before the draw-room one only: the journal is cut there.
	scratch = mkdtempSync(join(tmpdir(), 'sortea-migration-'));
	cpSync(migrationsFolder, scratch, { recursive: true });
	const journalPath = join(scratch, 'meta', '_journal.json');
	const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { idx: number; tag: string }[] };
	const target = journal.entries.find((entry) => entry.tag.endsWith('_draw_room_units'));
	if (!target) throw new Error('The draw_room_units migration is not in the journal');
	writeFileSync(journalPath, JSON.stringify({ ...journal, entries: journal.entries.filter((entry) => entry.idx < target.idx) }));
	await migrateWith(scratch);
});

afterAll(async () => {
	if (scratch) rmSync(scratch, { recursive: true, force: true });
	await admin(`drop database if exists ${name} with (force)`);
});

describe('migration draw_room_units', () => {
	it('keeps campaigns, awards and one-shot draws as they are, and adds the award order and a protected, append-only tirada table', async () => {
		const ids = { org: randomUUID(), campaign: randomUUID(), prize: randomUUID(), award: randomUUID(), draw: randomUUID() };
		const sql = postgres(url, { max: 1, onnotice: () => {} });
		try {
			await sql`insert into app.organizations (id, slug, name, order_prefix, settings) values (${ids.org}, ${`m-${ids.org.slice(0, 8)}`}, 'M', 'MM', ${sql.json({})})`;
			await sql`insert into app.campaigns (id, organization_id, slug, title, summary, timezone, opens_at, closes_at, status)
				values (${ids.campaign}, ${ids.org}, 'c', 'C', 'S', 'UTC', now(), now() + interval '1 day', 'awarding')`;
			await sql`insert into app.prizes (id, organization_id, campaign_id, position, kind, title, declared_value_minor, mechanism)
				values (${ids.prize}, ${ids.org}, ${ids.campaign}, 1, 'vehicle', 'Moto', 100, 'quiniela')`;
			await sql`insert into app.app_draws (id, organization_id, campaign_id, candidate_sha256, candidate_count, candidates, picks, drawn_at)
				values (${ids.draw}, ${ids.org}, ${ids.campaign}, ${'a'.repeat(64)}, 2, ${[3, 7]}, ${sql.json([{ prizeId: ids.prize, slot: 1, role: 'winner', rank: 1, entryNumber: 7 }])}, now())`;
			await sql`insert into app.prize_awards (id, organization_id, campaign_id, prize_id, slot, role, rank, notes, app_draw_id)
				values (${ids.award}, ${ids.org}, ${ids.campaign}, ${ids.prize}, 1, 'winner', 1, 'Sorteo en la app', ${ids.draw})`;
		} finally {
			await sql.end();
		}

		await migrateWith(migrationsFolder);

		const after = postgres(url, { max: 1, onnotice: () => {} });
		try {
			expect(await after`select award_order, status from app.campaigns where id = ${ids.campaign}`).toEqual([{ award_order: 'first_to_last', status: 'awarding' }]);
			expect(await after`select id, notes, app_draw_id, app_unit_draw_id from app.prize_awards where id = ${ids.award}`).toEqual([
				{ id: ids.award, notes: 'Sorteo en la app', app_draw_id: ids.draw, app_unit_draw_id: null }
			]);
			expect(await after`select candidates, candidate_count from app.app_draws where id = ${ids.draw}`).toEqual([{ candidates: [3, 7], candidate_count: 2 }]);

			const [table] = await after`select relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
				where n.nspname = 'app' and c.relname = 'app_unit_draws'`;
			expect(table).toEqual({ relrowsecurity: true });
			const policies = await after`select policyname from pg_policies where schemaname = 'app' and tablename = 'app_unit_draws'`;
			expect(policies.map((row) => row.policyname)).toEqual(['tenant_isolation']);
			const triggers = await after`select tgname from pg_trigger where tgrelid = 'app.app_unit_draws'::regclass and not tgisinternal`;
			expect(triggers.map((row) => row.tgname)).toEqual(['app_unit_draws_append_only']);

			await after`update app.campaigns set award_order = 'last_to_first' where id = ${ids.campaign}`;
			await expect(after`update app.campaigns set award_order = 'random' where id = ${ids.campaign}`).rejects.toThrow(/invalid input value for enum/);

			const tirada = (attempt: number, sequence: number, entryNumber = 3) =>
				after`insert into app.app_unit_draws (organization_id, campaign_id, round, sequence, prize_id, slot, attempt, candidate_sha256, candidate_count, candidates, entry_number, drawn_at)
					values (${ids.org}, ${ids.campaign}, 1, ${sequence}, ${ids.prize}, 1, ${attempt}, ${'b'.repeat(64)}, 1, ${[3]}, ${entryNumber}, now()) returning id`;
			const [row] = await tirada(1, 1);
			// The pick is one of the candidates; a unit's attempt and a round's sequence are each taken once.
			await expect(tirada(2, 2, 9)).rejects.toThrow(/app_unit_draws_candidates_check/);
			await expect(tirada(1, 2)).rejects.toThrow(/app_unit_draws_attempt_uq/);
			await expect(tirada(2, 1)).rejects.toThrow(/app_unit_draws_sequence_uq/);
			await expect(after`update app.app_unit_draws set entry_number = 3`).rejects.toThrow(/append-only/);
			await expect(after`delete from app.app_unit_draws`).rejects.toThrow(/append-only/);
			await after`insert into app.prize_awards (organization_id, campaign_id, prize_id, slot, role, rank, app_unit_draw_id)
				values (${ids.org}, ${ids.campaign}, ${ids.prize}, 1, 'winner', 2, ${row!.id})`;
		} finally {
			await after.end();
		}
	});
});
