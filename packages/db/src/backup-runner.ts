import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import postgres from 'postgres';
import {
	BackupRefusedError,
	backupKey,
	backupsPrefix,
	checksumKey,
	expiredBackups,
	listedBackups,
	parseBackupKey,
	pgEnvironment,
	type BackupEntry,
	type BackupReason,
	type RestoreArgs,
	type RestoreContext,
	type ServerIdentity
} from './backups';
import type { ObjectStore } from './object-store';

/**
 * Runs `pg_dump` and `pg_restore` for the backups of backups.ts. The tools
 * come from PATH, or from `PG_BIN_DIR` when set; they must be at least the
 * server's major version (the images ship postgresql-client-18). Credentials
 * travel as libpq variables, and the tools' error output is passed on with
 * the password removed.
 */

type BackupStore = Pick<ObjectStore, 'putStream' | 'getStream' | 'put' | 'list' | 'remove' | 'exists'>;

export interface BackupResult {
	key: string;
	bytes: number;
	sha256: string;
}

function tool(name: 'pg_dump' | 'pg_restore' | 'psql', env: Record<string, string | undefined> = process.env): string {
	return env.PG_BIN_DIR ? join(env.PG_BIN_DIR, name) : name;
}

function toolEnvironment(url: string): NodeJS.ProcessEnv {
	// The parent's own libpq variables must not leak into the connection.
	const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PG') || key === 'PG_BIN_DIR'));
	return { ...inherited, ...pgEnvironment(url) };
}

function redact(text: string, url: string): string {
	const password = pgEnvironment(url).PGPASSWORD;
	return (password ? text.split(password).join('***') : text).trim();
}

function exitOf(child: ReturnType<typeof spawn>, stderr: () => string, url: string, name: string): Promise<void> {
	return new Promise((resolve, reject) => {
		child.once('error', (error) => reject(new Error(`${name} could not start (${(error as NodeJS.ErrnoException).code ?? error.message}); install the PostgreSQL 17 client or set PG_BIN_DIR.`)));
		child.once('close', (code) => (code === 0 ? resolve() : reject(new Error(`${name} exited with ${code}: ${redact(stderr(), url)}`))));
	});
}

/**
 * Dumps the `app` schema of `databaseUrl` (custom format, so pg_restore can
 * select and reorder) straight into the bucket while hashing it, then writes
 * the `.sha256` sidecar. A failed dump leaves neither object behind.
 */
export async function takeBackup(options: { databaseUrl: string; store: BackupStore; environment: string; reason: BackupReason; now: Date }): Promise<BackupResult> {
	const key = backupKey(options.environment, options.now, options.reason);
	const child = spawn(tool('pg_dump'), ['--format=custom', '--schema=app', '--no-password'], { env: toolEnvironment(options.databaseUrl), stdio: ['ignore', 'pipe', 'pipe'] });
	let stderr = '';
	child.stderr!.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
	const exited = exitOf(child, () => stderr, options.databaseUrl, 'pg_dump');
	const hash = createHash('sha256');
	const hashing = new Transform({
		transform(chunk: Buffer, _encoding, callback) {
			hash.update(chunk);
			callback(null, chunk);
		}
	});
	// A failed upload stops reading pg_dump's output, so it is stopped too instead of waiting on a full pipe.
	// A stopped child closes its output; that surfaces through its exit code, not as an unhandled stream error.
	child.stdout!.on('error', () => {});
	const uploaded = options.store.putStream(key, child.stdout!.pipe(hashing), { contentType: 'application/octet-stream' }).catch((error: unknown) => {
		child.kill();
		throw error;
	});
	// Both settle before anything is decided, so a removal never races an upload still in flight.
	const [upload, exit] = await Promise.allSettled([uploaded, exited]);
	const failure = exit.status === 'rejected' ? exit.reason : upload.status === 'rejected' ? upload.reason : upload.value === 0 ? new Error('pg_dump produced an empty dump') : null;
	if (failure || upload.status !== 'fulfilled') {
		await options.store.remove([key]).catch(() => {});
		throw failure;
	}
	const bytes = upload.value;
	const sha256 = hash.digest('hex');
	await options.store.put(checksumKey(key), Buffer.from(`${sha256}  ${key.split('/').pop()}\n`), { contentType: 'text/plain; charset=utf-8' });
	return { key, bytes, sha256 };
}

export async function listBackups(store: Pick<ObjectStore, 'list'>, environment: string): Promise<BackupEntry[]> {
	return listedBackups(await store.list(backupsPrefix(environment)), environment);
}

/** Deletes what the retention no longer keeps (backups.ts, `expiredBackups`); returns the deleted dumps. */
export async function pruneBackups(store: Pick<ObjectStore, 'list' | 'remove'>, environment: string, now: Date): Promise<string[]> {
	const expired = expiredBackups(await listBackups(store, environment), now);
	if (expired.length > 0) await store.remove(expired);
	return expired.filter((key) => key.endsWith('.dump'));
}

/**
 * The database a connection string reaches, as its server describes itself:
 * `current_database()` and the cluster's `system_identifier`, which stays the
 * same under any host name or address that reaches the server.
 */
export async function serverIdentity(url: string): Promise<ServerIdentity> {
	const sql = postgres(url, { max: 1, onnotice: () => {}, connect_timeout: 10 });
	try {
		const [row] = await sql<{ database: string }[]>`select current_database() as database`;
		const systemIdentifier = await sql<{ id: string }[]>`select system_identifier::text as id from pg_control_system()`
			.then(([control]) => control?.id ?? null)
			.catch(() => null);
		return { database: row!.database, systemIdentifier };
	} finally {
		await sql.end();
	}
}

/**
 * What `restoreRefusal` checks a restore against: the target's identity
 * (it must answer, the restore needs it anyway) and, in production, the
 * identity of DATABASE_URL. Notes say when the production check falls back
 * to comparing connection strings; they never contain one.
 */
export async function restoreContext(
	args: Pick<RestoreArgs, 'target'>,
	env: Record<string, string | undefined>,
	identify: (url: string) => Promise<ServerIdentity> = serverIdentity
): Promise<{ context: RestoreContext; notes: string[] }> {
	const notes: string[] = [];
	const target = await identify(args.target);
	if (env.DEPLOY_ENVIRONMENT !== 'production') return { context: { target }, notes };
	if (!env.DATABASE_URL) {
		notes.push('DEPLOY_ENVIRONMENT=production but DATABASE_URL is not set: the production database cannot be recognised, so the restore needs --i-know-this-is-production.');
		return { context: { target, production: { url: null, identity: null } }, notes };
	}
	const identity = await identify(env.DATABASE_URL).catch(() => null);
	if (!identity) notes.push('DATABASE_URL did not answer: the production database cannot be recognised, so the restore needs --i-know-this-is-production.');
	else if (!identity.systemIdentifier || !target.systemIdentifier) {
		notes.push('A server would not give its system identifier (pg_control_system()): the production database cannot be recognised, so the restore needs --i-know-this-is-production.');
	}
	if (!target.systemIdentifier) notes.push('Without the system identifier of the target, --confirm takes the database name only.');
	return { context: { target, production: { url: env.DATABASE_URL, identity } }, notes };
}

/** Gives `sortea_app` to the restoring user, as migration 0001 does: the dump's grants and policies name it. */
export async function ensureTenantRole(url: string): Promise<void> {
	const sql = postgres(url, { max: 1, onnotice: () => {} });
	try {
		await sql.unsafe(`DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sortea_app') THEN
		CREATE ROLE sortea_app NOLOGIN NOINHERIT;
	END IF;
	EXECUTE format('GRANT sortea_app TO %I', current_user);
END $$`);
	} finally {
		await sql.end();
	}
}

/**
 * Restores a dump into `targetUrl`: downloads it to a temporary file, checks
 * it against its sidecar, then replaces the target's `app` schema in one
 * transaction: psql runs `DROP SCHEMA IF EXISTS app CASCADE` followed by the
 * script pg_restore writes, with ON_ERROR_STOP, so a failed restore leaves
 * the target as it was. (pg_restore's own `--clean` fails on a target whose
 * schema is missing or older.) The guards of `restoreRefusal` run before this
 * is called.
 */
export async function restoreBackup(options: { store: BackupStore; key: string; targetUrl: string }): Promise<{ bytes: number; sha256: string }> {
	if (!parseBackupKey(options.key)) throw new BackupRefusedError(`${options.key} is not a backup key.`);
	if (!(await options.store.exists(options.key))) throw new BackupRefusedError(`No backup ${options.key} in the bucket; list them with pnpm db:backups.`);
	const expected = await textOf(options.store, checksumKey(options.key)).catch(() => null);
	if (!expected) throw new BackupRefusedError(`${options.key} has no checksum (${checksumKey(options.key)}); it was not written completely.`);

	const dir = await mkdtemp(join(tmpdir(), 'sortea-restore-'));
	try {
		const file = join(dir, 'backup.dump');
		const hash = createHash('sha256');
		let bytes = 0;
		await pipeline(
			await options.store.getStream(options.key),
			new Transform({
				transform(chunk: Buffer, _encoding, callback) {
					hash.update(chunk);
					bytes += chunk.byteLength;
					callback(null, chunk);
				}
			}),
			createWriteStream(file)
		);
		const sha256 = hash.digest('hex');
		if (expected.split(/\s+/)[0] !== sha256) throw new BackupRefusedError(`${options.key} does not match its checksum; it was not restored.`);

		await ensureTenantRole(options.targetUrl);
		const env = toolEnvironment(options.targetUrl);
		const restore = spawn(tool('pg_restore'), ['--no-owner', '--file=-', file], { env, stdio: ['ignore', 'pipe', 'pipe'] });
		const psql = spawn(tool('psql'), ['--no-psqlrc', '--quiet', '--set=ON_ERROR_STOP=1', '--single-transaction', '--no-password', '--file=-'], { env, stdio: ['pipe', 'ignore', 'pipe'] });
		let restoreErrors = '';
		let psqlErrors = '';
		restore.stderr!.on('data', (chunk: Buffer) => (restoreErrors += chunk.toString()));
		psql.stderr!.on('data', (chunk: Buffer) => (psqlErrors += chunk.toString()));
		// When psql stops early (a failing statement), writing to it fails with EPIPE; that is
		// reported through psql's exit and its own error message, never as an unhandled error.
		psql.stdin!.on('error', () => {});
		restore.stdout!.on('error', () => {});
		let psqlFirst = false;
		const applied = exitOf(psql, () => psqlErrors, options.targetUrl, 'psql').finally(() => {
			// pg_restore would block on a pipe nobody reads any more.
			if (restore.exitCode === null && restore.signalCode === null) {
				psqlFirst = true;
				restore.kill();
			}
		});
		// Settled below; until then a psql failure must not surface as an unhandled rejection.
		applied.catch(() => {});
		const restored = exitOf(restore, () => restoreErrors, options.targetUrl, 'pg_restore');
		psql.stdin!.write('DROP SCHEMA IF EXISTS app CASCADE;\n');
		// psql commits whatever it read when its input ends, so a script cut short by a failed
		// pg_restore ends with a statement that fails instead: the transaction rolls back.
		restore.stdout!.pipe(psql.stdin!, { end: false });
		const [read] = await Promise.allSettled([restored]);
		if (!psql.stdin!.destroyed) {
			if (read!.status === 'rejected') psql.stdin!.write("\nDO $$ BEGIN RAISE EXCEPTION 'pg_restore failed; nothing restored'; END $$;\n");
			psql.stdin!.end();
		}
		const [written] = await Promise.allSettled([applied]);
		// The process that failed first holds the reason: psql's statement error, or pg_restore's own.
		if (written!.status === 'rejected' && (psqlFirst || read!.status === 'fulfilled')) throw written!.reason;
		if (read!.status === 'rejected') throw read!.reason;
		if (written!.status === 'rejected') throw written!.reason;
		return { bytes, sha256 };
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

async function textOf(store: BackupStore, key: string): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of await store.getStream(key)) chunks.push(Buffer.from(chunk));
	return Buffer.concat(chunks).toString('utf8');
}
