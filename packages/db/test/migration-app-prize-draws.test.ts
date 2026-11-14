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
 * The drand-backed tirada migrations (odd/tasks/draw-room.md T8, ADR 0026) on a
 * database at 0027 that already holds a campaign, Quiniela prizes, a per-unit
 * tirada and its award: 0028 only adds the `app` mechanism, 0029 only adds the
 * commitment and reveal tables, protected and append-only, and a column on the
 * awards. Found by their tags.
 */
const adminUrl = process.env.TEST_DATABASE_ADMIN_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const name = testDatabaseName('sortea_test_db_migration_app_prize_draws');
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
	// The migrations before the app mechanism one only: the journal is cut there.
	scratch = mkdtempSync(join(tmpdir(), 'sortea-migration-'));
	cpSync(migrationsFolder, scratch, { recursive: true });
	const journalPath = join(scratch, 'meta', '_journal.json');
	const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { idx: number; tag: string }[] };
	const target = journal.entries.find((entry) => entry.tag.endsWith('_app_prize_mechanism'));
	if (!target) throw new Error('The app_prize_mechanism migration is not in the journal');
	if (!journal.entries.some((entry) => entry.tag.endsWith('_app_prize_draws'))) throw new Error('The app_prize_draws migration is not in the journal');
	writeFileSync(journalPath, JSON.stringify({ ...journal, entries: journal.entries.filter((entry) => entry.idx < target.idx) }));
	await migrateWith(scratch);
});

afterAll(async () => {
	if (scratch) rmSync(scratch, { recursive: true, force: true });
	await admin(`drop database if exists ${name} with (force)`);
});

describe('migrations app_prize_mechanism and app_prize_draws', () => {
	it('keep prizes, tiradas and awards as they are, and add the app mechanism and protected, append-only commitments and reveals', async () => {
		const ids = { org: randomUUID(), campaign: randomUUID(), prize: randomUUID(), tirada: randomUUID(), award: randomUUID(), app: randomUUID() };
		const sql = postgres(url, { max: 1, onnotice: () => {} });
		try {
			await sql`insert into app.organizations (id, slug, name, order_prefix, settings) values (${ids.org}, ${`m-${ids.org.slice(0, 8)}`}, 'M', 'MM', ${sql.json({})})`;
			await sql`insert into app.campaigns (id, organization_id, slug, title, summary, timezone, opens_at, closes_at, status)
				values (${ids.campaign}, ${ids.org}, 'c', 'C', 'S', 'UTC', now(), now() + interval '1 day', 'awarding')`;
			await sql`insert into app.prizes (id, organization_id, campaign_id, position, kind, title, declared_value_minor, mechanism)
				values (${ids.prize}, ${ids.org}, ${ids.campaign}, 1, 'vehicle', 'Moto', 100, 'quiniela')`;
			await sql`insert into app.app_unit_draws (id, organization_id, campaign_id, round, sequence, prize_id, slot, attempt, candidate_sha256, candidate_count, candidates, entry_number, drawn_at)
				values (${ids.tirada}, ${ids.org}, ${ids.campaign}, 1, 1, ${ids.prize}, 1, 1, ${'b'.repeat(64)}, 2, ${[3, 7]}, 7, now())`;
			await sql`insert into app.prize_awards (id, organization_id, campaign_id, prize_id, slot, role, rank, notes, app_unit_draw_id)
				values (${ids.award}, ${ids.org}, ${ids.campaign}, ${ids.prize}, 1, 'winner', 1, 'Sorteo en la app', ${ids.tirada})`;
			// Before the migration the mechanism does not exist.
			await expect(sql`update app.prizes set mechanism = 'app' where id = ${ids.prize}`).rejects.toThrow(/invalid input value for enum/);
		} finally {
			await sql.end();
		}

		await migrateWith(migrationsFolder);

		const after = postgres(url, { max: 1, onnotice: () => {} });
		try {
			expect(await after`select mechanism, title from app.prizes where id = ${ids.prize}`).toEqual([{ mechanism: 'quiniela', title: 'Moto' }]);
			expect(await after`select id, notes, app_unit_draw_id, app_prize_draw_id from app.prize_awards where id = ${ids.award}`).toEqual([
				{ id: ids.award, notes: 'Sorteo en la app', app_unit_draw_id: ids.tirada, app_prize_draw_id: null }
			]);
			expect(await after`select candidates, entry_number from app.app_unit_draws where id = ${ids.tirada}`).toEqual([{ candidates: [3, 7], entry_number: 7 }]);
			const [labels] = await after`select enum_range(null::app.prize_mechanism)::text[] as mechanisms`;
			expect(labels!.mechanisms).toEqual(['quiniela', 'manual', 'app']);
			await after`insert into app.prizes (id, organization_id, campaign_id, position, kind, title, declared_value_minor, quantity, mechanism)
				values (${ids.app}, ${ids.org}, ${ids.campaign}, 2, 'cash', 'Efectivo', 100, 5, 'app')`;

			for (const table of ['app_prize_draws', 'app_prize_draw_reveals']) {
				const [row] = await after`select relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'app' and c.relname = ${table}`;
				expect(row, table).toEqual({ relrowsecurity: true });
				const policies = await after`select policyname from pg_policies where schemaname = 'app' and tablename = ${table}`;
				expect(policies.map((policy) => policy.policyname), table).toEqual(['tenant_isolation']);
				const triggers = await after`select tgname from pg_trigger where tgrelid = ${`app.${table}`}::regclass and not tgisinternal`;
				expect(triggers.map((trigger) => trigger.tgname), table).toEqual([`${table}_append_only`]);
			}

			const commit = (attempt: number, sequence: number, slots = [1, 2, 3, 4, 5], candidates = [3, 7]) =>
				after`insert into app.app_prize_draws (organization_id, campaign_id, round, sequence, prize_id, attempt, slots, drand_chain, drand_round, candidate_sha256, candidate_count, candidates, committed_at)
					values (${ids.org}, ${ids.campaign}, 1, ${sequence}, ${ids.app}, ${attempt}, ${slots}, 'quicknet', 1000000, ${'c'.repeat(64)}, ${candidates.length}, ${candidates}, now()) returning id`;
			const [first] = await commit(1, 1);
			// A prize's attempt and a round's sequence are each taken once; units and candidates are never empty.
			await expect(commit(1, 2)).rejects.toThrow(/app_prize_draws_attempt_uq/);
			await expect(commit(2, 1)).rejects.toThrow(/app_prize_draws_sequence_uq/);
			await expect(commit(2, 2, [])).rejects.toThrow(/app_prize_draws_numbers_check/);
			await expect(commit(2, 2, [1], [])).rejects.toThrow(/app_prize_draws_candidates_check/);

			const reveal = (drandRound: number) =>
				after`insert into app.app_prize_draw_reveals (organization_id, campaign_id, draw_id, drand_round, signature, randomness, picks, revealed_at)
					values (${ids.org}, ${ids.campaign}, ${first!.id}, ${drandRound}, ${'ab'.repeat(48)}, ${'d'.repeat(64)}, ${after.json([{ slot: 1, entryNumber: 7 }])}, now())`;
			// The reveal is of the committed round, never another one, and only once.
			await expect(reveal(1_000_001)).rejects.toThrow(/app_prize_draw_reveals_draw_fk/);
			await reveal(1_000_000);
			await expect(reveal(1_000_000)).rejects.toThrow(/app_prize_draw_reveals_draw_uq/);

			for (const table of ['app_prize_draws', 'app_prize_draw_reveals']) {
				await expect(after.unsafe(`update app.${table} set drand_round = drand_round`)).rejects.toThrow(/append-only/);
				await expect(after.unsafe(`delete from app.${table}`)).rejects.toThrow(/append-only/);
			}
			await after`insert into app.prize_awards (organization_id, campaign_id, prize_id, slot, role, rank, app_prize_draw_id)
				values (${ids.org}, ${ids.campaign}, ${ids.app}, 1, 'winner', 1, ${first!.id})`;
		} finally {
			await after.end();
		}
	});
});
