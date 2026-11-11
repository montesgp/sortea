import { BACKUPS_PREFIX } from './object-store';

/**
 * Database dumps of our own (ADR 0020, "Backups of our own"): `pg_dump -Fc` of
 * the `app` schema into the environment's bucket, under
 * `backups/<environment>/<UTC timestamp>-<reason>.dump`, each with a
 * `<key>.sha256` sidecar. This module holds the rules (names, retention,
 * schedule, restore guards); backup-runner.ts runs the tools.
 */

export const BACKUP_REASONS = ['nightly', 'pre-migrate', 'manual'] as const;
export type BackupReason = (typeof BACKUP_REASONS)[number];

export const RETENTION = {
	/** The newest nightly dumps kept. */
	nightly: 14,
	/** The newest nightly dumps taken on a Sunday (UTC) kept, on top of the nightly ones. */
	weekly: 8,
	/** Pre-migration and manual dumps are kept this long. */
	days: 30
} as const;

const ENVIRONMENT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const STAMP = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/;
const DAY_MS = 86_400_000;
/** A dump without its checksum this old was cut short (the sidecar is written right after the upload). */
const INCOMPLETE_GRACE_MS = 3_600_000;

export interface ParsedBackupKey {
	key: string;
	environment: string;
	at: Date;
	reason: BackupReason;
}

export interface BackupEntry extends ParsedBackupKey {
	/** Its `.sha256` sidecar exists: the upload finished and restore accepts it. */
	complete: boolean;
}

export class BackupRefusedError extends Error {}

/**
 * A value for an error message: a command-line value that looks like a
 * connection string (or carries credentials) is never repeated.
 */
export function echo(value: string): string {
	return /:\/\/|@/.test(value) ? '(a connection string, not repeated here)' : value;
}

export function assertEnvironmentName(environment: string): void {
	if (!ENVIRONMENT.test(environment)) throw new BackupRefusedError(`${echo(environment)} is not an environment name: use lowercase letters, digits and dashes.`);
}

/** `20261110T060000Z`: sortable, no characters that need escaping in a key. */
export function backupStamp(at: Date): string {
	return at.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '');
}

export function backupsPrefix(environment: string): string {
	assertEnvironmentName(environment);
	return `${BACKUPS_PREFIX}${environment}/`;
}

export function backupKey(environment: string, at: Date, reason: BackupReason): string {
	return `${backupsPrefix(environment)}${backupStamp(at)}-${reason}.dump`;
}

export function checksumKey(key: string): string {
	return `${key}.sha256`;
}

/** The dump a key names, or null for anything else under the prefix (sidecars, foreign files). */
export function parseBackupKey(key: string): ParsedBackupKey | null {
	if (!key.startsWith(BACKUPS_PREFIX)) return null;
	const [environment, name, ...rest] = key.slice(BACKUPS_PREFIX.length).split('/');
	if (!environment || !name || rest.length > 0 || !ENVIRONMENT.test(environment) || !name.endsWith('.dump')) return null;
	const dash = name.indexOf('-');
	const stamp = STAMP.exec(name.slice(0, dash));
	const reason = name.slice(dash + 1, -'.dump'.length);
	if (dash < 0 || !stamp || !(BACKUP_REASONS as readonly string[]).includes(reason)) return null;
	const [, y, mo, d, h, mi, s] = stamp.map(Number) as [number, number, number, number, number, number, number];
	const at = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
	if (backupStamp(at) !== name.slice(0, dash)) return null;
	return { key, environment, at, reason: reason as BackupReason };
}

/** Dumps of one environment, newest first, each marked complete when its sidecar is listed; other keys are left out. */
export function listedBackups(keys: string[], environment: string): BackupEntry[] {
	const present = new Set(keys);
	return keys
		.map(parseBackupKey)
		.filter((entry): entry is ParsedBackupKey => entry !== null && entry.environment === environment)
		.map((entry) => ({ ...entry, complete: present.has(checksumKey(entry.key)) }))
		.sort((a, b) => b.at.getTime() - a.at.getTime());
}

/**
 * Keys to delete under the retention: the newest 14 nightly dumps, the newest 8
 * nightly dumps taken on a Sunday (UTC), and every pre-migration or manual dump
 * of the last 30 days stay. The newest dump of all always stays, and keys that
 * are not dumps are never selected. Each deleted dump takes its sidecar along.
 * Dumps without their sidecar count for nothing (restore refuses them) and are
 * deleted once an hour old; a younger one may still be getting its sidecar.
 */
export function expiredBackups(entries: BackupEntry[], now: Date): string[] {
	const incomplete = entries.filter((entry) => !entry.complete);
	const cut = incomplete.filter((entry) => now.getTime() - entry.at.getTime() > INCOMPLETE_GRACE_MS);
	const newestFirst = entries.filter((entry) => entry.complete).sort((a, b) => b.at.getTime() - a.at.getTime());
	const keep = new Set<string>();
	if (newestFirst[0]) keep.add(newestFirst[0].key);
	const nightly = newestFirst.filter((entry) => entry.reason === 'nightly');
	for (const entry of nightly.slice(0, RETENTION.nightly)) keep.add(entry.key);
	for (const entry of nightly.filter((e) => e.at.getUTCDay() === 0).slice(0, RETENTION.weekly)) keep.add(entry.key);
	const since = now.getTime() - RETENTION.days * DAY_MS;
	for (const entry of newestFirst) if (entry.reason !== 'nightly' && entry.at.getTime() >= since) keep.add(entry.key);
	return [...newestFirst.filter((entry) => !keep.has(entry.key)), ...cut].flatMap((entry) => [entry.key, checksumKey(entry.key)]);
}

export interface BackupSchedule {
	enabled: boolean;
	/** Hour of the day (UTC) from which the night's dump is due. */
	hourUtc: number;
	environment: string;
}

/**
 * The worker's schedule from its variables: off unless `BACKUP_ENABLED=true`
 * (`false` or unset is off; any other value refuses to start, so a typo never
 * switches backups off silently);
 * `BACKUP_HOUR_UTC` defaults to 6 (03:00 in Argentina); `DEPLOY_ENVIRONMENT`
 * names the prefix and defaults to `development`.
 */
export function backupScheduleFromEnv(env: Record<string, string | undefined>): BackupSchedule {
	const environment = env.DEPLOY_ENVIRONMENT || 'development';
	assertEnvironmentName(environment);
	const raw = env.BACKUP_HOUR_UTC ?? '6';
	const hourUtc = Number(raw);
	if (!/^\d{1,2}$/.test(raw) || hourUtc > 23) throw new BackupRefusedError('BACKUP_HOUR_UTC must be an hour from 0 to 23.');
	const enabled = env.BACKUP_ENABLED ?? '';
	if (!['', 'true', 'false'].includes(enabled)) throw new BackupRefusedError('BACKUP_ENABLED must be true or false.');
	return { enabled: enabled === 'true', hourUtc, environment };
}

/** The latest moment the nightly dump became due: today at the hour, or yesterday when that is still ahead. */
export function nightlySlot(now: Date, hourUtc: number): Date {
	const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hourUtc);
	return new Date(today <= now.getTime() ? today : today - DAY_MS);
}

/**
 * Whether the worker must dump now: no nightly dump exists since the latest
 * slot. The bucket's listing is the record, so a restarted worker never dumps
 * twice for one night, and one that was down at the hour catches up once.
 */
export function nightlyBackupDue(now: Date, hourUtc: number, latestNightly: Date | null): boolean {
	return latestNightly === null || latestNightly.getTime() < nightlySlot(now, hourUtc).getTime();
}

/** Host, port and database of a connection string, never its user or password. */
export function describeDatabase(url: string): string {
	const parsed = new URL(url);
	return `${parsed.hostname}:${parsed.port || '5432'}${parsed.pathname}`;
}

export function databaseName(url: string): string {
	return decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
}

/**
 * Same host, port and database as written, whatever the credentials or options.
 * Another spelling of the host (its IP, a trailing dot) is not recognised:
 * only a fallback when the servers cannot be asked (`sameServerDatabase`).
 */
export function sameDatabase(a: string, b: string): boolean {
	const [x, y] = [new URL(a), new URL(b)];
	return x.hostname.toLowerCase() === y.hostname.toLowerCase() && (x.port || '5432') === (y.port || '5432') && databaseName(a) === databaseName(b);
}

/**
 * libpq variables for `pg_dump` and `pg_restore`, so the password never
 * appears in a command line (visible to other processes) or in output.
 */
export function pgEnvironment(url: string): Record<string, string> {
	const parsed = new URL(url);
	if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') throw new BackupRefusedError('The database must be a postgres:// or postgresql:// connection string.');
	const env: Record<string, string> = {
		PGHOST: parsed.hostname.replace(/^\[|\]$/g, ''),
		PGPORT: parsed.port || '5432',
		PGDATABASE: databaseName(url),
		PGUSER: decodeURIComponent(parsed.username),
		PGPASSWORD: decodeURIComponent(parsed.password)
	};
	const sslmode = parsed.searchParams.get('sslmode');
	if (sslmode) env.PGSSLMODE = sslmode;
	return env;
}

/** Who a database is, asked from the server itself: `pg_control_system()` names the cluster, whatever host name reaches it. */
export interface ServerIdentity {
	database: string;
	/** Null when the server would not say (the role may not run `pg_control_system()`). */
	systemIdentifier: string | null;
}

/** Whether two identities are the same database of the same cluster; null when either cluster is unknown. */
export function sameServerDatabase(a: ServerIdentity, b: ServerIdentity): boolean | null {
	if (!a.systemIdentifier || !b.systemIdentifier) return null;
	return a.systemIdentifier === b.systemIdentifier && a.database === b.database;
}

/**
 * What `--confirm` must say for a target: `<database>@<last 6 digits of the
 * server's system identifier>`, so two servers whose databases share a name
 * (every Railway database is `railway`) need different confirmations; just the
 * database name when the identifier is unknown.
 */
export function confirmationFor(target: ServerIdentity): string {
	return target.systemIdentifier ? `${target.database}@${target.systemIdentifier.slice(-6)}` : target.database;
}

export const restoreUsage =
	'Usage: pnpm db:restore <backup key> --target <database URL> --confirm <database>@<server> [--i-know-this-is-production]';

export interface RestoreArgs {
	key: string;
	target: string;
	confirm?: string;
	production: boolean;
}

export function parseRestoreArgs(argv: string[]): RestoreArgs {
	const positional: string[] = [];
	let target: string | undefined;
	let confirm: string | undefined;
	let production = false;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (arg === '--target' || arg === '--confirm') {
			const value = argv[++i];
			if (!value || value.startsWith('--')) throw new BackupRefusedError(`${arg} needs a value. ${restoreUsage}`);
			if (arg === '--target') target = value;
			else confirm = value;
		} else if (arg === '--i-know-this-is-production') production = true;
		// Only the flag is repeated: what follows `=` may be a connection string.
		else if (arg.startsWith('-')) throw new BackupRefusedError(`Unexpected argument ${arg.includes('=') ? `${arg.split('=')[0]}=…` : echo(arg)}. ${restoreUsage}`);
		else positional.push(arg);
	}
	if (positional.length !== 1 || !target) throw new BackupRefusedError(restoreUsage);
	return { key: positional[0]!, target, ...(confirm ? { confirm } : {}), production };
}

/** What a restore is checked against, gathered by `restoreContext` (backup-runner.ts). */
export interface RestoreContext {
	/** The target as its server describes itself; unknown in pure checks. */
	target?: ServerIdentity;
	/**
	 * Present when DEPLOY_ENVIRONMENT=production. `url` is null when DATABASE_URL is not set and
	 * `identity` is null when it did not answer: then the production database cannot be recognised.
	 */
	production?: { url: string | null; identity: ServerIdentity | null };
}

/**
 * Why a restore must not run, or null. A restore replaces the `app` schema of
 * the target, so `--confirm` must repeat what `confirmationFor` names for it
 * (database and server), and it refuses the environment's own production
 * database (DATABASE_URL with DEPLOY_ENVIRONMENT=production) unless
 * `--i-know-this-is-production` is given. Production is recognised by the
 * servers' identities, so another spelling of the host does not pass; when an
 * identity is unknown, by the connection strings.
 */
export function restoreRefusal(args: RestoreArgs, context: RestoreContext): string | null {
	if (!parseBackupKey(args.key)) return `${echo(args.key)} is not a backup key (backups/<environment>/<timestamp>-<reason>.dump); list them with pnpm db:backups.`;
	let name: string;
	try {
		pgEnvironment(args.target);
		name = databaseName(args.target);
	} catch {
		return 'The target must be a postgres:// or postgresql:// connection string.';
	}
	if (!name) return 'The target connection string names no database.';
	const target = context.target ?? { database: name, systemIdentifier: null };
	const expected = confirmationFor(target);
	if (args.confirm !== expected) {
		const server = target.systemIdentifier ? ` (server …${target.systemIdentifier.slice(-6)})` : '';
		return `Restoring replaces the app schema of ${describeDatabase(args.target)}${server}. Pass --confirm ${expected} to confirm the target.`;
	}
	const { production } = context;
	if (production && !args.production) {
		// Only the servers' system identifiers tell databases apart for sure (any host spelling or
		// IP reaches the same server); without them, production fails closed.
		if (!production.identity?.systemIdentifier || !target.systemIdentifier) {
			return 'In production the target can be told apart from this environment\'s own database only by the servers\' system identifiers, which could not be read. Add --i-know-this-is-production to restore anyway.';
		}
		if (sameServerDatabase(target, production.identity)) return "The target is this production environment's own database (DATABASE_URL). Restore into another database first, or add --i-know-this-is-production.";
	}
	return null;
}
