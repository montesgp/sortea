import { testDatabaseName } from '../src/testing';
import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listBackups, pruneBackups, restoreBackup, restoreContext, serverIdentity, takeBackup } from '../src/backup-runner';
import { BackupRefusedError, backupsPrefix, checksumKey, confirmationFor, restoreRefusal } from '../src/backups';
import { runMigrations } from '../src/migrator';
import { createObjectStore, type ObjectStoreConfig } from '../src/object-store';

/**
 * Backup and restore end to end (ADR 0020, "Backups of our own"): pg_dump of a
 * migrated database into a real S3 API, then pg_restore into another
 * database. Opt-in, because it needs the PostgreSQL 17 client tools and
 * MinIO: set BACKUP_TEST=1 and S3_TEST_ENDPOINT (S3_TEST_ACCESS_KEY_ID and
 * S3_TEST_SECRET_ACCESS_KEY unless they are the compose defaults), with
 * pg_dump and pg_restore on PATH or in PG_BIN_DIR. It uses throwaway
 * databases on the TEST_DATABASE_ADMIN_URL server and its own environment
 * prefix in the `sortea-test` bucket, and removes both.
 */
const enabled = process.env.BACKUP_TEST === '1' && Boolean(process.env.S3_TEST_ENDPOINT);
const adminUrl = process.env.TEST_DATABASE_ADMIN_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const databaseUrl = (name: string) => Object.assign(new URL(adminUrl), { pathname: `/${name}` }).toString();
const source = testDatabaseName('sortea_test_backup_source');
const target = testDatabaseName('sortea_test_backup_target');

const config: ObjectStoreConfig = {
	endpoint: process.env.S3_TEST_ENDPOINT ?? 'http://127.0.0.1:9000',
	region: 'us-east-1',
	bucket: 'sortea-test',
	accessKeyId: process.env.S3_TEST_ACCESS_KEY_ID ?? 'sortea-local',
	secretAccessKey: process.env.S3_TEST_SECRET_ACCESS_KEY ?? 'sortea-local-secret',
	forcePathStyle: true
};
const store = createObjectStore(config);
const environment = `test-${randomUUID().slice(0, 8)}`;
const org = { id: randomUUID(), slug: `backup-${randomUUID().slice(0, 8)}` };

async function admin(statement: string) {
	const client = postgres(adminUrl, { max: 1, onnotice: () => {} });
	try {
		await client.unsafe(statement);
	} finally {
		await client.end();
	}
}

async function query<T extends Record<string, unknown>>(name: string, statement: string): Promise<T[]> {
	const client = postgres(databaseUrl(name), { max: 1, onnotice: () => {} });
	try {
		return (await client.unsafe(statement)) as unknown as T[];
	} finally {
		await client.end();
	}
}

/** What a restore must bring back: the rows, the migration record, the policies and the tenant role's grants. */
async function shape(name: string) {
	const [row] = await query<{ organizations: number; migrations: number; policies: number; tenant_can_read: boolean }>(
		name,
		`select (select count(*)::int from app.organizations where slug = '${org.slug}') as organizations,
		        (select count(*)::int from app.__migrations) as migrations,
		        (select count(*)::int from pg_policies where schemaname = 'app') as policies,
		        has_table_privilege('sortea_app', 'app.organizations', 'select') as tenant_can_read`
	);
	return row;
}

describe.skipIf(!enabled)('backup and restore on Postgres and MinIO', () => {
	beforeAll(async () => {
		await store.ensureBucket();
		for (const name of [source, target]) {
			await admin(`drop database if exists ${name} with (force)`);
			await admin(`create database ${name}`);
		}
		await runMigrations(databaseUrl(source));
		await query(source, `insert into app.organizations (id, slug, name, order_prefix, settings) values ('${org.id}', '${org.slug}', 'Backup', 'BK', '{}')`);
	});

	afterAll(async () => {
		await store.remove(await store.list(backupsPrefix(environment)));
		for (const name of [source, target]) await admin(`drop database if exists ${name} with (force)`);
	});

	let key: string;

	it('dumps the database into the bucket with a checksum sidecar', async () => {
		const result = await takeBackup({ databaseUrl: databaseUrl(source), store, environment, reason: 'manual', now: new Date() });
		key = result.key;
		expect(key).toMatch(new RegExp(`^backups/${environment}/\\d{8}T\\d{6}Z-manual\\.dump$`));
		expect(result.bytes).toBeGreaterThan(1000);
		expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
		expect(await store.list(backupsPrefix(environment))).toEqual([key, checksumKey(key)]);
		expect((await listBackups(store, environment)).map((entry) => entry.key)).toEqual([key]);
	});

	it('restores it into an empty database, with its migrations, policies and grants', async () => {
		const restored = await restoreBackup({ store, key, targetUrl: databaseUrl(target) });
		expect(restored.bytes).toBeGreaterThan(1000);
		expect(await shape(target)).toEqual(await shape(source));
		expect((await shape(target))!.organizations).toBe(1);
		// A restored database is up to date for this release: nothing left to migrate.
		expect(await runMigrations(databaseUrl(target))).toEqual([]);
	});

	it('restores again over a database that already has the schema', async () => {
		await query(target, `delete from app.organizations where slug = '${org.slug}'`);
		await restoreBackup({ store, key, targetUrl: databaseUrl(target) });
		expect((await shape(target))!.organizations).toBe(1);
	});

	it('refuses a dump that does not match its checksum and leaves the target as it was', async () => {
		await store.put(checksumKey(key), Buffer.from(`${'0'.repeat(64)}  x.dump\n`), { contentType: 'text/plain' });
		await query(target, `delete from app.organizations where slug = '${org.slug}'`);
		await expect(restoreBackup({ store, key, targetUrl: databaseUrl(target) })).rejects.toThrow(BackupRefusedError);
		expect((await shape(target))!.organizations).toBe(0);
	});

	it('leaves nothing in the bucket when the dump fails, and never names the password', async () => {
		const wrong = Object.assign(new URL(databaseUrl(testDatabaseName('sortea_test_backup_missing'))), { password: 'not-the-password-123' }).toString();
		const failure = takeBackup({ databaseUrl: wrong, store, environment, reason: 'manual', now: new Date(Date.now() + 5000) });
		await expect(failure).rejects.toThrow(/pg_dump exited with/);
		await expect(failure).rejects.not.toThrow(/not-the-password-123/);
		expect(await store.list(backupsPrefix(environment))).toEqual([key, checksumKey(key)]);
	});

	it('reports a failed apply, rolls back and removes its temporary copy', async () => {
		// The dump names a type outside the app schema, which the target does not have: psql fails mid-script.
		await query(source, `create type public.vt5 as enum ('a'); create table app.zz_vt5 (x public.vt5)`);
		const bad = await takeBackup({ databaseUrl: databaseUrl(source), store, environment, reason: 'manual', now: new Date(Date.now() + 10000) });
		const before = await shape(target);
		await expect(restoreBackup({ store, key: bad.key, targetUrl: databaseUrl(target) })).rejects.toThrow(/psql exited/);
		expect(await shape(target)).toEqual(before);
		expect(readdirSync(tmpdir()).filter((d) => d.startsWith('sortea-restore-'))).toEqual([]);
		await query(source, `drop table app.zz_vt5; drop type public.vt5`);
	});

	it('reports a failed apply while pg_restore is still writing, without an unhandled error', async () => {
		// Independent re-verification of b841dbc: a large dump keeps pg_restore writing after psql fails.
		await query(source, `create type public.vt6 as enum ('a'); create table app.zz_vt6 (x public.vt6); create table app.zz_big (t text); insert into app.zz_big select repeat(md5(g::text), 40) from generate_series(1, 60000) g`);
		const bad = await takeBackup({ databaseUrl: databaseUrl(source), store, environment, reason: 'manual', now: new Date(Date.now() + 15000) });
		const before = await shape(target);
		await expect(restoreBackup({ store, key: bad.key, targetUrl: databaseUrl(target) })).rejects.toThrow(/psql exited/);
		expect(await shape(target)).toEqual(before);
		expect(readdirSync(tmpdir()).filter((d) => d.startsWith('sortea-restore-'))).toEqual([]);
		await query(source, `drop table app.zz_big, app.zz_vt6; drop type public.vt6`);
	});

	it('refuses the production database written as another spelling of its server', async () => {
		const production = databaseUrl(target);
		const host = new URL(production).hostname;
		const { address } = await lookup(host, { family: 4 });
		const env = { DEPLOY_ENVIRONMENT: 'production', DATABASE_URL: production };
		// A trailing dot is another spelling of a host name only; an IP address has none.
		for (const alias of isIP(host) ? [address] : [address, `${host}.`]) {
			const targetUrl = Object.assign(new URL(production), { hostname: alias }).toString();
			const { context, notes } = await restoreContext({ target: targetUrl }, env);
			expect(notes).toEqual([]);
			const args = { key, target: targetUrl, confirm: confirmationFor(context.target!), production: false };
			expect(restoreRefusal(args, context), alias).toMatch(/production environment's own database/);
			expect(restoreRefusal({ ...args, production: true }, context)).toBeNull();
		}
		// Another database of the same server is not the production one.
		const other = databaseUrl(source);
		const { context } = await restoreContext({ target: other }, env);
		expect(context.target).toEqual({ database: source, systemIdentifier: (await serverIdentity(production)).systemIdentifier });
		expect(restoreRefusal({ key, target: other, confirm: confirmationFor(context.target!), production: false }, context)).toBeNull();
	});

	it('keeps the newest dumps under the retention', async () => {
		expect(await pruneBackups(store, environment, new Date())).toEqual([]);
	});
});
