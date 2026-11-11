import { randomUUID } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { campaignStatuses } from '@sortea/domain';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrationsFolder } from '../src/scripts/migrate';
import { testDatabaseName } from '../src/testing';

/**
 * The draft-dates migration (S5, owner feedback 2026-11-10) on a database that
 * already holds campaigns in every status: their dates stay as they were, and
 * from then on only a draft, a campaign in review or an archived one may lack
 * its opening or closing. The migration is found by its tag, not its number.
 */
const adminUrl = process.env.TEST_DATABASE_ADMIN_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const name = testDatabaseName('sortea_test_db_migration_draft_dates');
const url = Object.assign(new URL(adminUrl), { pathname: `/${name}` }).toString();
const opensAt = new Date('2026-11-01T03:00:00.000Z');
const closesAt = new Date('2026-12-20T23:00:00.000Z');
const undatedAllowed = ['draft', 'review', 'archived'];
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
	// The migrations before the draft-dates one only: the journal is cut there.
	scratch = mkdtempSync(join(tmpdir(), 'sortea-migration-'));
	cpSync(migrationsFolder, scratch, { recursive: true });
	const journalPath = join(scratch, 'meta', '_journal.json');
	const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { idx: number; tag: string }[] };
	const draftDates = journal.entries.find((entry) => entry.tag.endsWith('_campaign_draft_dates'));
	if (!draftDates) throw new Error('The campaign_draft_dates migration is not in the journal');
	writeFileSync(journalPath, JSON.stringify({ ...journal, entries: journal.entries.filter((entry) => entry.idx < draftDates.idx) }));
	await migrateWith(scratch);
});

afterAll(async () => {
	if (scratch) rmSync(scratch, { recursive: true, force: true });
	await admin(`drop database if exists ${name} with (force)`);
});

describe('migration campaign_draft_dates', () => {
	it('keeps existing dates and lets only draft, review and archived campaigns lose them', async () => {
		const org = randomUUID();
		const campaigns = campaignStatuses.map((status) => ({ status, id: randomUUID() }));
		expect(campaigns).toHaveLength(8);
		const sql = postgres(url, { max: 1, onnotice: () => {} });
		try {
			await sql`insert into app.organizations (id, slug, name, order_prefix, settings) values (${org}, ${`m-${org.slice(0, 8)}`}, 'M', 'MM', ${sql.json({})})`;
			for (const { status, id } of campaigns) {
				await sql`insert into app.campaigns (id, organization_id, slug, title, summary, status, timezone, opens_at, closes_at)
					values (${id}, ${org}, ${status}, ${status}, 'S', ${status}, 'UTC', ${opensAt}, ${closesAt})`;
			}
		} finally {
			await sql.end();
		}

		await migrateWith(migrationsFolder);

		const after = postgres(url, { max: 1, onnotice: () => {} });
		try {
			const rows = await after`select status, opens_at, closes_at from app.campaigns where organization_id = ${org} order by status`;
			expect(rows).toHaveLength(8);
			for (const row of rows) expect(row).toMatchObject({ opens_at: opensAt, closes_at: closesAt });

			for (const { status, id } of campaigns) {
				const clear = after`update app.campaigns set opens_at = null where id = ${id}`;
				if (undatedAllowed.includes(status)) await expect(clear, status).resolves.toBeDefined();
				else await expect(clear, status).rejects.toMatchObject({ code: '23514', constraint_name: 'campaigns_schedule_check' });
			}
			const cleared = await after`select status from app.campaigns where organization_id = ${org} and opens_at is null order by status`;
			expect(cleared.map((row) => row.status).sort()).toEqual([...undatedAllowed].sort());
		} finally {
			await after.end();
		}
	});
});
