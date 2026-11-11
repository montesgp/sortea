import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	assertLocalTarget,
	countMismatches,
	DUMP_DIRECTORY_PREFIX,
	dumpFromSupabase,
	ImportRefusedError,
	parseCounts,
	parseImportArgs,
	pickSupabaseContainer,
	restoreIntoCompose,
	type SourceDocker,
	type TableCounts,
	type TargetDatabase,
	type TargetDocker
} from '../src/supabase-import';

// The one-time move of a local database off the Supabase CLI stack (README, "Moving off the
// Supabase CLI"): its guards and its order of work, with docker and the target faked.

const LOCAL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const COUNTS: TableCounts = { organizations: 4, orders: 128, admin_users: 8, __migrations: 19 };
const CLUSTER = '7400000000000123456';

let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), DUMP_DIRECTORY_PREFIX));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

function fakeSource(running: string[], calls: string[] = []): SourceDocker {
	return {
		async running() {
			return running;
		},
		async query(container, sql) {
			calls.push(`query ${container}`);
			expect(sql).toContain('app.organizations');
			return '4|128|8|19\n';
		},
		async dump(container, file) {
			calls.push(`dump ${container}`);
			await writeFile(file, 'PGDMP fake archive');
		}
	};
}

interface TargetFakes {
	calls: string[];
	docker: TargetDocker;
	database: TargetDatabase;
}

function fakeTarget(options: { container?: string | null; cluster?: string; hasApp?: boolean; after?: TableCounts } = {}): TargetFakes {
	const calls: string[] = [];
	const docker: TargetDocker = {
		async composeContainer() {
			calls.push('composeContainer');
			return options.container === undefined ? 'sortea-postgres-1' : options.container;
		},
		async systemIdentifier(container) {
			calls.push(`systemIdentifier ${container}`);
			return options.cluster ?? CLUSTER;
		},
		async restore(container, file, target) {
			calls.push(`restore ${container} ${target.user}@${target.database}`);
			expect(existsSync(file)).toBe(true);
		}
	};
	const database: TargetDatabase = {
		async identity() {
			calls.push('identity');
			return { database: 'postgres', systemIdentifier: CLUSTER };
		},
		async hasAppSchema() {
			calls.push('hasAppSchema');
			return options.hasApp ?? false;
		},
		async ensureTenantRole() {
			calls.push('ensureTenantRole');
		},
		async counts() {
			calls.push('counts');
			return options.after ?? COUNTS;
		}
	};
	return { calls, docker, database };
}

async function takeDump(): Promise<string> {
	const { file } = await dumpFromSupabase({}, { docker: fakeSource(['supabase_db_sortea']), directory: dir, now: new Date('2026-11-10T12:00:00Z') });
	return file;
}

describe('parseImportArgs', () => {
	it('reads the two steps', () => {
		expect(parseImportArgs(['--dump-only'])).toEqual({ mode: 'dump' });
		expect(parseImportArgs(['--dump-only', '--container', 'supabase_db_other'])).toEqual({ mode: 'dump', container: 'supabase_db_other' });
		expect(parseImportArgs(['--restore', 'C:\\tmp\\app.dump'])).toEqual({ mode: 'restore', file: 'C:\\tmp\\app.dump', replace: false });
		expect(parseImportArgs(['--restore', 'a.dump', '--replace', '--target-container', 'c1'])).toEqual({ mode: 'restore', file: 'a.dump', replace: true, targetContainer: 'c1' });
	});

	it('refuses no step, both steps, missing values and unknown flags, never repeating a connection string', () => {
		for (const argv of [[], ['--dump-only', '--restore', 'a.dump'], ['--restore'], ['--restore', '--replace'], ['--dump-only', '--container'], ['--dump-only', '--replace']]) {
			expect(() => parseImportArgs(argv)).toThrow(ImportRefusedError);
		}
		expect(() => parseImportArgs(['--dump-only', '--target=postgresql://u:hunter2@db/x'])).toThrow(/Unexpected argument --target=…/);
		expect(() => parseImportArgs(['--dump-only', 'postgresql://u:hunter2@db/x'])).not.toThrow(/hunter2/);
	});
});

describe('pickSupabaseContainer', () => {
	it('finds the one running Supabase database container by name', () => {
		expect(pickSupabaseContainer(['sortea-minio-1', 'supabase_db_sortea', 'supabase_kong_sortea'])).toBe('supabase_db_sortea');
	});

	it('refuses when none or several run, unless one is named', () => {
		expect(() => pickSupabaseContainer(['sortea-minio-1'])).toThrow('No Supabase database container (supabase_db_<project>) is running');
		expect(() => pickSupabaseContainer(['supabase_db_sortea', 'supabase_db_other'])).toThrow('Several Supabase database containers run (supabase_db_sortea, supabase_db_other): pass --container <name>.');
		expect(pickSupabaseContainer(['supabase_db_sortea', 'supabase_db_other'], 'supabase_db_other')).toBe('supabase_db_other');
		expect(() => pickSupabaseContainer(['supabase_db_sortea'], 'supabase_db_gone')).toThrow('Container supabase_db_gone is not running.');
	});
});

describe('assertLocalTarget', () => {
	it('accepts this machine only, whatever ALLOW_DESTRUCTIVE_DB says, without repeating credentials', () => {
		expect(() => assertLocalTarget(LOCAL)).not.toThrow();
		expect(() => assertLocalTarget('postgresql://u:p@localhost:5432/app')).not.toThrow();
		const previous = process.env.ALLOW_DESTRUCTIVE_DB;
		process.env.ALLOW_DESTRUCTIVE_DB = 'yes';
		try {
			for (const url of ['postgresql://u:hunter2@postgres.railway.internal:5432/railway', 'postgresql://u:hunter2@10.0.0.4/app']) {
				expect(() => assertLocalTarget(url)).toThrow(/is for a database on this machine only/);
				expect(() => assertLocalTarget(url)).not.toThrow(/hunter2/);
			}
		} finally {
			if (previous === undefined) delete process.env.ALLOW_DESTRUCTIVE_DB;
			else process.env.ALLOW_DESTRUCTIVE_DB = previous;
		}
		expect(() => assertLocalTarget('not a url')).toThrow('DATABASE_URL must be a postgres:// connection string to the local database.');
	});
});

describe('counts', () => {
	it('parses the psql row and names every table that differs', () => {
		expect(parseCounts('4|128|8|19\n')).toEqual(COUNTS);
		expect(() => parseCounts('4|128')).toThrow(ImportRefusedError);
		expect(countMismatches(COUNTS, COUNTS)).toEqual([]);
		expect(countMismatches(COUNTS, { ...COUNTS, orders: 127, __migrations: 18 })).toEqual(['orders: 128 in the dump, 127 restored', '__migrations: 19 in the dump, 18 restored']);
	});
});

describe('dumpFromSupabase', () => {
	it('dumps the detected container into the directory with a manifest of its counts and checksum', async () => {
		const calls: string[] = [];
		const { file, manifest } = await dumpFromSupabase({}, { docker: fakeSource(['sortea-minio-1', 'supabase_db_sortea'], calls), directory: dir, now: new Date('2026-11-10T12:00:00Z') });
		expect(calls).toEqual(['query supabase_db_sortea', 'dump supabase_db_sortea']);
		expect(file).toBe(join(dir, 'app.dump'));
		const bytes = await readFile(file);
		expect(manifest).toEqual({
			container: 'supabase_db_sortea',
			takenAt: '2026-11-10T12:00:00.000Z',
			bytes: bytes.length,
			sha256: createHash('sha256').update(bytes).digest('hex'),
			counts: COUNTS
		});
		expect(JSON.parse(await readFile(`${file}.json`, 'utf8'))).toEqual(manifest);
	});

	it('writes nothing when no Supabase database runs', async () => {
		const calls: string[] = [];
		await expect(dumpFromSupabase({}, { docker: fakeSource(['sortea-minio-1'], calls), directory: dir, now: new Date() })).rejects.toThrow(ImportRefusedError);
		expect(calls).toEqual([]);
		expect(existsSync(join(dir, 'app.dump'))).toBe(false);
	});
});

describe('restoreIntoCompose', () => {
	it('restores into the compose Postgres, checks the counts and deletes the dump', async () => {
		const file = await takeDump();
		const target = fakeTarget();
		const result = await restoreIntoCompose({ file, replace: false }, { targetUrl: LOCAL, ...target });
		expect(target.calls).toEqual(['composeContainer', 'systemIdentifier sortea-postgres-1', 'identity', 'hasAppSchema', 'ensureTenantRole', 'restore sortea-postgres-1 postgres@postgres', 'counts']);
		expect(result).toEqual({ container: 'sortea-postgres-1', source: COUNTS, target: COUNTS, mismatches: [], deleted: true });
		expect(existsSync(file)).toBe(false);
		expect(existsSync(`${file}.json`)).toBe(false);
		expect(existsSync(dir)).toBe(false);
	});

	it('refuses a non-local DATABASE_URL before touching docker or the database', async () => {
		const file = await takeDump();
		const target = fakeTarget();
		await expect(restoreIntoCompose({ file, replace: true }, { targetUrl: 'postgresql://u:p@db.example.test/app', ...target })).rejects.toThrow(/this machine only/);
		expect(target.calls).toEqual([]);
		expect(existsSync(file)).toBe(true);
	});

	it('refuses a target that already has the app schema unless --replace', async () => {
		const file = await takeDump();
		const kept = fakeTarget({ hasApp: true });
		await expect(restoreIntoCompose({ file, replace: false }, { targetUrl: LOCAL, ...kept })).rejects.toThrow(
			'The database at 127.0.0.1:54322/postgres already has the app schema. Pass --replace to replace it (its current data is lost).'
		);
		expect(kept.calls).not.toContain('ensureTenantRole');
		expect(kept.calls.some((call) => call.startsWith('restore'))).toBe(false);
		expect(existsSync(file)).toBe(true);

		const replaced = fakeTarget({ hasApp: true });
		const result = await restoreIntoCompose({ file, replace: true }, { targetUrl: LOCAL, ...replaced });
		expect(result.deleted).toBe(true);
		expect(replaced.calls).toContain('restore sortea-postgres-1 postgres@postgres');
	});

	it('refuses when DATABASE_URL reaches another server than the compose container', async () => {
		const file = await takeDump();
		const target = fakeTarget({ cluster: '7499999999999999999' });
		await expect(restoreIntoCompose({ file, replace: true }, { targetUrl: LOCAL, ...target })).rejects.toThrow(/does not reach the Postgres of sortea-postgres-1/);
		expect(target.calls.some((call) => call.startsWith('restore'))).toBe(false);
	});

	it('refuses when the compose Postgres is not running, and uses a named container instead', async () => {
		const file = await takeDump();
		await expect(restoreIntoCompose({ file, replace: false }, { targetUrl: LOCAL, ...fakeTarget({ container: null }) })).rejects.toThrow(/pnpm db:start/);
		const named = fakeTarget({ container: null });
		await restoreIntoCompose({ file, replace: false, targetContainer: 'smoke-postgres-1' }, { targetUrl: LOCAL, ...named });
		expect(named.calls[0]).toBe('systemIdentifier smoke-postgres-1');
	});

	it('refuses a dump without its manifest or that does not match its checksum', async () => {
		const file = await takeDump();
		await writeFile(file, 'PGDMP changed');
		const target = fakeTarget();
		await expect(restoreIntoCompose({ file, replace: false }, { targetUrl: LOCAL, ...target })).rejects.toThrow('does not match its checksum');
		await rm(`${file}.json`);
		await expect(restoreIntoCompose({ file, replace: false }, { targetUrl: LOCAL, ...target })).rejects.toThrow('has no manifest');
		expect(target.calls).toEqual([]);
	});

	it('keeps the dump and reports the tables whose counts differ', async () => {
		const file = await takeDump();
		const target = fakeTarget({ after: { ...COUNTS, orders: 100 } });
		const result = await restoreIntoCompose({ file, replace: false }, { targetUrl: LOCAL, ...target });
		expect(result).toMatchObject({ mismatches: ['orders: 128 in the dump, 100 restored'], deleted: false });
		expect(existsSync(file)).toBe(true);
		expect(existsSync(`${file}.json`)).toBe(true);
	});
});
