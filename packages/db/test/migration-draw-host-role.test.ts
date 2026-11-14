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
 * The draw host role migration (odd/tasks/draw-room.md T4) on a database at
 * 0026 with an organization and its members: it only adds the `draw_host`
 * value to `org_role`, so every member keeps their role and a draw host can be
 * added afterwards. Found by its tag.
 */
const adminUrl = process.env.TEST_DATABASE_ADMIN_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const name = testDatabaseName('sortea_test_db_migration_draw_host');
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
	// The migrations before the draw host one only: the journal is cut there.
	scratch = mkdtempSync(join(tmpdir(), 'sortea-migration-'));
	cpSync(migrationsFolder, scratch, { recursive: true });
	const journalPath = join(scratch, 'meta', '_journal.json');
	const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { idx: number; tag: string }[] };
	const target = journal.entries.find((entry) => entry.tag.endsWith('_draw_host_role'));
	if (!target) throw new Error('The draw_host_role migration is not in the journal');
	writeFileSync(journalPath, JSON.stringify({ ...journal, entries: journal.entries.filter((entry) => entry.idx < target.idx) }));
	await migrateWith(scratch);
});

afterAll(async () => {
	if (scratch) rmSync(scratch, { recursive: true, force: true });
	await admin(`drop database if exists ${name} with (force)`);
});

describe('migration draw_host_role', () => {
	it('keeps every member as they are and accepts a draw host afterwards', async () => {
		const org = randomUUID();
		const [owner, operator, host] = [randomUUID(), randomUUID(), randomUUID()];
		const sql = postgres(url, { max: 1, onnotice: () => {} });
		try {
			await sql`insert into app.organizations (id, slug, name, order_prefix, settings) values (${org}, ${`m-${org.slice(0, 8)}`}, 'M', 'MM', ${sql.json({})})`;
			await sql`insert into app.organization_members (organization_id, user_id, email, role) values
				(${org}, ${owner}, 'owner@m.test', 'org_owner'), (${org}, ${operator}, 'operator@m.test', 'campaign_operator')`;
			// Before the migration the role does not exist.
			await expect(sql`insert into app.organization_members (organization_id, user_id, email, role) values (${org}, ${host}, 'host@m.test', 'draw_host')`).rejects.toThrow(
				/invalid input value for enum/
			);
		} finally {
			await sql.end();
		}

		await migrateWith(migrationsFolder);

		const after = postgres(url, { max: 1, onnotice: () => {} });
		try {
			expect(await after`select user_id, role, status from app.organization_members where organization_id = ${org} order by email`).toEqual([
				{ user_id: operator, role: 'campaign_operator', status: 'active' },
				{ user_id: owner, role: 'org_owner', status: 'active' }
			]);
			await after`insert into app.organization_members (organization_id, user_id, email, role) values (${org}, ${host}, 'host@m.test', 'draw_host')`;
			expect(await after`select role from app.organization_members where user_id = ${host}`).toEqual([{ role: 'draw_host' }]);
			const [labels] = await after`select enum_range(null::app.org_role)::text[] as roles`;
			expect(labels!.roles).toEqual(['org_owner', 'org_admin', 'finance_manager', 'campaign_operator', 'auditor', 'support_agent', 'draw_host']);
			await expect(after`update app.organization_members set role = 'draw_boss' where user_id = ${host}`).rejects.toThrow(/invalid input value for enum/);
		} finally {
			await after.end();
		}
	});
});
