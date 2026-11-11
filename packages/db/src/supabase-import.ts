import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { readFile, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { databaseName, describeDatabase, echo, type ServerIdentity } from './backups';

/**
 * The one-time move of a local database off the Supabase CLI stack onto the
 * Postgres of docker-compose.yml (ADR 0020, "Local development"; README,
 * "Moving off the Supabase CLI"). Both listen on 127.0.0.1:54322, so it runs
 * in two steps with the Supabase CLI stopped in between:
 *
 *   --dump-only          `pg_dump -Fc` of the `app` schema from inside the Supabase database
 *                        container into a file under the OS temp directory, with a manifest of
 *                        its checksum and row counts
 *   --restore <file>     restores it into the compose Postgres that DATABASE_URL reaches, checks
 *                        the counts and deletes the file when they match
 *
 * Only `app` is carried over, as in the backups (backups.ts): it holds every
 * table and the migrations journal, while Supabase's own schemas (auth,
 * storage, realtime...) and roles do not exist on a plain Postgres. This
 * module holds the rules and the order of work; docker and the target
 * database are ports, so the guards are tested with fakes.
 */

export class ImportRefusedError extends Error {}

/** --dump-only writes into `mkdtemp(<OS temp>/sortea-supabase-import-)`; a verified restore removes that directory. */
export const DUMP_DIRECTORY_PREFIX = 'sortea-supabase-import-';

export const importUsage = [
	'Usage: pnpm db:import-from-supabase --dump-only [--container <supabase_db_container>]',
	'       pnpm db:import-from-supabase --restore <file> [--replace] [--target-container <container>]'
].join('\n');

export type ImportArgs = { mode: 'dump'; container?: string } | { mode: 'restore'; file: string; replace: boolean; targetContainer?: string };

export function parseImportArgs(argv: string[]): ImportArgs {
	let dump = false;
	let replace = false;
	let file: string | undefined;
	let container: string | undefined;
	let targetContainer: string | undefined;
	const value = (flag: string, next: string | undefined): string => {
		if (!next || next.startsWith('--')) throw new ImportRefusedError(`${flag} needs a value.\n${importUsage}`);
		return next;
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (arg === '--dump-only') dump = true;
		else if (arg === '--replace') replace = true;
		else if (arg === '--restore') file = value(arg, argv[++i]);
		else if (arg === '--container') container = value(arg, argv[++i]);
		else if (arg === '--target-container') targetContainer = value(arg, argv[++i]);
		// Only the flag is repeated: what follows `=` may be a connection string.
		else throw new ImportRefusedError(`Unexpected argument ${arg.includes('=') ? `${arg.split('=')[0]}=…` : echo(arg)}.\n${importUsage}`);
	}
	if (dump === (file !== undefined)) throw new ImportRefusedError(importUsage);
	if (dump) {
		if (replace || targetContainer) throw new ImportRefusedError(`--replace and --target-container belong to --restore.\n${importUsage}`);
		return container ? { mode: 'dump', container } : { mode: 'dump' };
	}
	if (container) throw new ImportRefusedError(`--container belongs to --dump-only.\n${importUsage}`);
	return { mode: 'restore', file: file!, replace, ...(targetContainer ? { targetContainer } : {}) };
}

/** The Supabase CLI names a project's database container `supabase_db_<project id>`. */
export function pickSupabaseContainer(running: string[], requested?: string): string {
	if (requested) {
		if (!running.includes(requested)) throw new ImportRefusedError(`Container ${requested} is not running.`);
		return requested;
	}
	const found = running.filter((name) => name.startsWith('supabase_db_'));
	if (found.length === 0) {
		throw new ImportRefusedError('No Supabase database container (supabase_db_<project>) is running. Start the Supabase CLI stack (supabase start) or pass --container <name>.');
	}
	if (found.length > 1) throw new ImportRefusedError(`Several Supabase database containers run (${found.join(', ')}): pass --container <name>.`);
	return found[0]!;
}

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** The restore replaces the target's `app` schema: only on this machine, with no override. */
export function assertLocalTarget(url: string): void {
	let host: string;
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') throw new Error();
		host = parsed.hostname;
	} catch {
		throw new ImportRefusedError('DATABASE_URL must be a postgres:// connection string to the local database.');
	}
	if (!LOCAL_HOSTS.has(host)) throw new ImportRefusedError(`Refusing to restore into ${host}: this one-time import is for a database on this machine only.`);
}

/** Tables counted on both sides; their sum of rows proves nothing, each count must match. */
export const COUNTED_TABLES = ['organizations', 'orders', 'admin_users', '__migrations'] as const;
export type TableCounts = Record<(typeof COUNTED_TABLES)[number], number>;

/** One row, `|`-separated in psql's unaligned output, in the order of COUNTED_TABLES. */
export const COUNTS_SQL = `select ${COUNTED_TABLES.map((table) => `(select count(*) from app.${table})`).join(', ')}`;

export function parseCounts(text: string): TableCounts {
	const values = text.trim().split('|').map(Number);
	if (values.length !== COUNTED_TABLES.length || values.some((n) => !Number.isInteger(n) || n < 0)) {
		throw new ImportRefusedError('Could not read the row counts of the Supabase database.');
	}
	return Object.fromEntries(COUNTED_TABLES.map((table, index) => [table, values[index]])) as TableCounts;
}

export function formatCounts(counts: TableCounts): string {
	return COUNTED_TABLES.map((table) => `${table} ${counts[table]}`).join(', ');
}

export function countMismatches(source: TableCounts, target: TableCounts): string[] {
	return COUNTED_TABLES.filter((table) => source[table] !== target[table]).map((table) => `${table}: ${source[table]} in the dump, ${target[table]} restored`);
}

/** Written next to the dump as `<file>.json`; the restore checks the file against it and compares the counts. */
export interface DumpManifest {
	container: string;
	takenAt: string;
	bytes: number;
	sha256: string;
	counts: TableCounts;
}

export interface SourceDocker {
	/** Names of the running containers. */
	running(): Promise<string[]>;
	/** psql's unaligned output of one statement, run in the container as `postgres` on database `postgres`. */
	query(container: string, sql: string): Promise<string>;
	/** `pg_dump --format=custom --schema=app` of database `postgres`, run in the container, written to `file`. */
	dump(container: string, file: string): Promise<void>;
}

export interface TargetDocker {
	/** The running container of the compose `postgres` service, or null. */
	composeContainer(): Promise<string | null>;
	systemIdentifier(container: string): Promise<string>;
	/** Replaces the `app` schema of `target.database` with the dump in one transaction, as `target.user`. */
	restore(container: string, file: string, target: { user: string; database: string }): Promise<void>;
}

/** The database DATABASE_URL reaches. */
export interface TargetDatabase {
	identity(): Promise<ServerIdentity>;
	hasAppSchema(): Promise<boolean>;
	/** The role the dump's grants and policies name (migration 0001). */
	ensureTenantRole(): Promise<void>;
	counts(): Promise<TableCounts>;
}

async function sha256Of(file: string): Promise<string> {
	const hash = createHash('sha256');
	for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
	return hash.digest('hex');
}

/** Step 1, read-only on Supabase: the counts first, then the dump, so rows written meanwhile show up as a mismatch. */
export async function dumpFromSupabase(
	args: { container?: string },
	deps: { docker: SourceDocker; directory: string; now: Date }
): Promise<{ file: string; manifest: DumpManifest }> {
	const container = pickSupabaseContainer(await deps.docker.running(), args.container);
	const counts = parseCounts(await deps.docker.query(container, COUNTS_SQL));
	const file = join(deps.directory, 'app.dump');
	await deps.docker.dump(container, file);
	const { size } = await stat(file);
	if (size === 0) throw new ImportRefusedError('pg_dump produced an empty dump.');
	const manifest: DumpManifest = { container, takenAt: deps.now.toISOString(), bytes: size, sha256: await sha256Of(file), counts };
	await writeFile(`${file}.json`, `${JSON.stringify(manifest, null, 2)}\n`);
	return { file, manifest };
}

async function readManifest(file: string): Promise<DumpManifest> {
	const path = `${file}.json`;
	if (!existsSync(file)) throw new ImportRefusedError(`${file} does not exist.`);
	if (!existsSync(path)) throw new ImportRefusedError(`${file} has no manifest (${path}); take the dump with --dump-only.`);
	try {
		const manifest = JSON.parse(await readFile(path, 'utf8')) as DumpManifest;
		parseCounts(COUNTED_TABLES.map((table) => manifest.counts[table]).join('|'));
		if (typeof manifest.sha256 !== 'string') throw new Error();
		return manifest;
	} catch {
		throw new ImportRefusedError(`${path} is not a manifest written by --dump-only.`);
	}
}

export interface RestoreResult {
	container: string;
	source: TableCounts;
	target: TableCounts;
	mismatches: string[];
	/** The dump and its manifest were deleted: only after the counts matched. */
	deleted: boolean;
}

/**
 * Step 2: every guard runs before anything is written. DATABASE_URL must be
 * on this machine and reach the same cluster as the compose container (while
 * the Supabase CLI still holds port 54322, it reaches Supabase instead), and
 * a target that already has the `app` schema is replaced only with --replace.
 */
export async function restoreIntoCompose(
	args: { file: string; replace: boolean; targetContainer?: string },
	deps: { targetUrl: string; docker: TargetDocker; database: TargetDatabase }
): Promise<RestoreResult> {
	assertLocalTarget(deps.targetUrl);
	const manifest = await readManifest(args.file);
	if ((await sha256Of(args.file)) !== manifest.sha256) throw new ImportRefusedError(`${args.file} does not match its checksum; take the dump again.`);

	const container = args.targetContainer ?? (await deps.docker.composeContainer());
	if (!container) throw new ImportRefusedError('The compose Postgres is not running: stop the Supabase CLI stack, then run pnpm db:start.');
	const cluster = await deps.docker.systemIdentifier(container);
	const identity = await deps.database.identity();
	if (identity.systemIdentifier !== cluster) {
		throw new ImportRefusedError(
			`DATABASE_URL (${describeDatabase(deps.targetUrl)}) does not reach the Postgres of ${container}: another server answers there. Is the Supabase CLI stack still running?`
		);
	}
	if ((await deps.database.hasAppSchema()) && !args.replace) {
		throw new ImportRefusedError(`The database at ${describeDatabase(deps.targetUrl)} already has the app schema. Pass --replace to replace it (its current data is lost).`);
	}

	await deps.database.ensureTenantRole();
	await deps.docker.restore(container, args.file, { user: decodeURIComponent(new URL(deps.targetUrl).username) || 'postgres', database: databaseName(deps.targetUrl) });
	const target = await deps.database.counts();
	const mismatches = countMismatches(manifest.counts, target);
	if (mismatches.length === 0) {
		await rm(args.file, { force: true });
		await rm(`${args.file}.json`, { force: true });
		// The directory --dump-only created, when nothing else is in it.
		if (basename(dirname(args.file)).startsWith(DUMP_DIRECTORY_PREFIX)) await rmdir(dirname(args.file)).catch(() => {});
	}
	return { container, source: manifest.counts, target, mismatches, deleted: mismatches.length === 0 };
}
