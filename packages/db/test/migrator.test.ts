import { testDatabaseName } from '../src/testing';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { migrationsFolder, pendingMigrations, readJournal, runMigrations, type MigrationPlan } from '../src/migrator';

/**
 * The release migrator (the API's pre-deploy, ADR 0020): it reports what is
 * pending before it migrates, lets the pre-migration backup stop it, and
 * serializes concurrent runs with an advisory lock.
 */
const adminUrl = process.env.TEST_DATABASE_ADMIN_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const name = testDatabaseName('sortea_test_db_migrator');
const url = Object.assign(new URL(adminUrl), { pathname: `/${name}` }).toString();
const journal = readJournal();
const tags = journal.map((entry) => entry.tag);
const scratch = mkdtempSync(join(tmpdir(), 'sortea-migrator-'));

async function admin(statement: string) {
	const client = postgres(adminUrl, { max: 1, onnotice: () => {} });
	try {
		await client.unsafe(statement);
	} finally {
		await client.end();
	}
}

/** The migrations folder without its last migration, as the previous release had it. */
function previousRelease(): string {
	const folder = join(scratch, 'previous');
	cpSync(migrationsFolder, folder, { recursive: true });
	const path = join(folder, 'meta', '_journal.json');
	const file = JSON.parse(readFileSync(path, 'utf8')) as { entries: unknown[] };
	writeFileSync(path, JSON.stringify({ ...file, entries: file.entries.slice(0, -1) }));
	return folder;
}

beforeEach(async () => {
	await admin(`drop database if exists ${name} with (force)`);
	await admin(`create database ${name}`);
});

afterAll(async () => {
	rmSync(scratch, { recursive: true, force: true });
	await admin(`drop database if exists ${name} with (force)`);
});

describe('pending migrations', () => {
	it('are those newer than the last one recorded, or all of them', () => {
		expect(pendingMigrations(journal, null)).toEqual(tags);
		expect(pendingMigrations(journal, journal.at(-2)!.when)).toEqual([tags.at(-1)]);
		expect(pendingMigrations(journal, journal.at(-1)!.when)).toEqual([]);
	});
});

describe('runMigrations', () => {
	it('on a fresh database reports every migration and no data, then has nothing left', async () => {
		const plans: MigrationPlan[] = [];
		expect(await runMigrations(url, { beforeMigrate: async (plan) => void plans.push(plan) })).toEqual(tags);
		expect(plans).toEqual([{ pending: tags, hasData: false }]);

		expect(await runMigrations(url, { beforeMigrate: async (plan) => void plans.push(plan) })).toEqual([]);
		expect(plans).toHaveLength(1);
	});

	it('on a database of the previous release reports its data, and a failing backup stops the migration', async () => {
		await runMigrations(url, { migrationsFolder: previousRelease() });
		const plans: MigrationPlan[] = [];
		await expect(
			runMigrations(url, {
				beforeMigrate: async (plan) => {
					plans.push(plan);
					throw new Error('bucket unreachable');
				}
			})
		).rejects.toThrow('bucket unreachable');
		expect(plans).toEqual([{ pending: [tags.at(-1)], hasData: true }]);

		// Nothing was applied: the same migration is still pending.
		expect(await runMigrations(url)).toEqual([tags.at(-1)]);
	});

	it('serializes concurrent releases: one applies, the other finds nothing pending', async () => {
		const results = await Promise.all([runMigrations(url), runMigrations(url), runMigrations(url)]);
		expect(results.filter((applied) => applied.length > 0)).toEqual([tags]);
		expect(results.filter((applied) => applied.length === 0)).toHaveLength(2);
	});
});
