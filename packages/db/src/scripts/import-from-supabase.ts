import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { ensureTenantRole, serverIdentity } from '../backup-runner';
import { describeDatabase } from '../backups';
import {
	COUNTS_SQL,
	dumpFromSupabase,
	DUMP_DIRECTORY_PREFIX,
	formatCounts,
	ImportRefusedError,
	parseCounts,
	parseImportArgs,
	restoreIntoCompose,
	type SourceDocker,
	type TargetDatabase,
	type TargetDocker
} from '../supabase-import';
import { databaseUrl } from './env';

/**
 * Carries a local database off the Supabase CLI stack onto the compose
 * Postgres, once (README, "Moving off the Supabase CLI"; rules in
 * supabase-import.ts):
 *
 *   pnpm db:import-from-supabase --dump-only [--container <name>]
 *   (stop the Supabase CLI stack, then pnpm db:start)
 *   pnpm db:import-from-supabase --restore <file> [--replace] [--target-container <name>]
 *
 * pg_dump, pg_restore and psql run inside the containers through docker, so
 * no PostgreSQL client is needed on this machine. It prints file paths,
 * container names and row counts, never a connection string.
 */

const root = fileURLToPath(new URL('../../../..', import.meta.url));
const IN_CONTAINER_DUMP = '/tmp/sortea-import.dump';
const IN_CONTAINER_SQL = '/tmp/sortea-import.sql';

function docker(args: string[], options: { cwd?: string } = {}): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn('docker', args, { cwd: options.cwd ?? root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
		let out = '';
		let err = '';
		child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
		child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString()));
		child.once('error', (error) => reject(new Error(`docker could not start (${(error as NodeJS.ErrnoException).code ?? error.message}); is Docker Desktop installed?`)));
		child.once('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`docker ${args[0]} exited with ${code}: ${err.trim()}`))));
	});
}

const psql = (container: string, user: string, database: string, sql: string) =>
	docker(['exec', container, 'psql', `--username=${user}`, `--dbname=${database}`, '--no-psqlrc', '--tuples-only', '--no-align', '--field-separator=|', `--command=${sql}`]);

const source: SourceDocker = {
	async running() {
		return (await docker(['ps', '--format', '{{.Names}}'])).split(/\r?\n/).filter(Boolean);
	},
	query: (container, sql) => psql(container, 'postgres', 'postgres', sql),
	async dump(container, file) {
		const child = spawn('docker', ['exec', container, 'pg_dump', '--username=postgres', '--dbname=postgres', '--format=custom', '--schema=app'], {
			stdio: ['ignore', 'pipe', 'pipe'],
			windowsHide: true
		});
		let err = '';
		child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString()));
		const exited = new Promise<void>((resolve, reject) => {
			child.once('error', reject);
			child.once('close', (code) => (code === 0 ? resolve() : reject(new Error(`pg_dump exited with ${code}: ${err.trim()}`))));
		});
		try {
			await Promise.all([pipeline(child.stdout, createWriteStream(file)), exited]);
		} catch (error) {
			await rm(file, { force: true });
			throw error;
		}
	}
};

const target: TargetDocker = {
	async composeContainer() {
		const id = (await docker(['compose', 'ps', '--quiet', '--status', 'running', 'postgres'])).trim();
		return id || null;
	},
	async systemIdentifier(container) {
		return (await psql(container, 'postgres', 'postgres', 'select system_identifier from pg_control_system()')).trim();
	},
	async restore(container, file, { user, database }) {
		try {
			await docker(['cp', file, `${container}:${IN_CONTAINER_DUMP}`]);
			// pg_restore writes the script first, so a broken archive stops before psql changes anything.
			await docker(['exec', container, 'pg_restore', '--no-owner', `--file=${IN_CONTAINER_SQL}`, IN_CONTAINER_DUMP]);
			await docker([
				'exec',
				'--env=PGOPTIONS=--client-min-messages=warning',
				container,
				'psql',
				`--username=${user}`,
				`--dbname=${database}`,
				'--no-psqlrc',
				'--quiet',
				'--set=ON_ERROR_STOP=1',
				'--single-transaction',
				'--command=DROP SCHEMA IF EXISTS app CASCADE',
				`--file=${IN_CONTAINER_SQL}`
			]);
		} finally {
			await docker(['exec', container, 'rm', '-f', IN_CONTAINER_DUMP, IN_CONTAINER_SQL]).catch(() => {});
		}
	}
};

function targetDatabase(url: string): TargetDatabase {
	const query = async <T>(run: (sql: postgres.Sql) => Promise<T>): Promise<T> => {
		const sql = postgres(url, { max: 1, onnotice: () => {}, connect_timeout: 10 });
		try {
			return await run(sql);
		} finally {
			await sql.end();
		}
	};
	return {
		identity: () => serverIdentity(url),
		hasAppSchema: () => query(async (sql) => Boolean((await sql<{ exists: boolean }[]>`select to_regnamespace('app') is not null as exists`)[0]?.exists)),
		ensureTenantRole: () => ensureTenantRole(url),
		counts: () =>
			query(async (sql) => {
				const row = (await sql.unsafe(COUNTS_SQL).values())[0] as unknown[];
				return parseCounts(row.map(String).join('|'));
			})
	};
}

try {
	const args = parseImportArgs(process.argv.slice(2));
	if (args.mode === 'dump') {
		const directory = await mkdtemp(join(tmpdir(), DUMP_DIRECTORY_PREFIX));
		try {
			const { file, manifest } = await dumpFromSupabase(args, { docker: source, directory, now: new Date() });
			console.log(`Dumped the app schema of ${manifest.container} (${manifest.bytes} bytes): ${formatCounts(manifest.counts)}.`);
			console.log(`File: ${file}`);
			console.log(
				[
					'Next (README, "Moving off the Supabase CLI"):',
					`  supabase stop --project-id ${manifest.container.slice('supabase_db_'.length)}   (keeps its data volume)`,
					'  pnpm db:start',
					`  pnpm db:import-from-supabase --restore "${file}"`
				].join('\n')
			);
		} catch (error) {
			await rm(directory, { recursive: true, force: true });
			throw error;
		}
	} else {
		const url = databaseUrl();
		const result = await restoreIntoCompose(args, { targetUrl: url, docker: target, database: targetDatabase(url) });
		// `docker compose ps` gives the container's id, a name was given with --target-container.
		const container = /^[0-9a-f]{64}$/.test(result.container) ? result.container.slice(0, 12) : result.container;
		console.log(`Restored into ${describeDatabase(url)} (container ${container}).`);
		console.log(`  dump:     ${formatCounts(result.source)}`);
		console.log(`  restored: ${formatCounts(result.target)}`);
		if (result.mismatches.length > 0) {
			console.error(`Counts differ, so the dump was kept at ${args.file}:\n  ${result.mismatches.join('\n  ')}`);
			process.exitCode = 1;
		} else console.log('Counts match; the dump and its manifest were deleted. Run pnpm db:migrate if this release has newer migrations.');
	}
} catch (error) {
	console.error(error instanceof ImportRefusedError ? error.message : error instanceof Error ? error.message : error);
	process.exitCode = 1;
}
