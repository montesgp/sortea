import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

/**
 * The migration files: `packages/db/migrations` when running from sources, or
 * the `migrations` directory a build copies next to the bundle (`dist/`), so
 * the compiled API applies the same files (scripts/bundle.mjs).
 */
function findMigrationsFolder(): string {
	const bundled = fileURLToPath(new URL('./migrations', import.meta.url));
	return existsSync(`${bundled}/meta/_journal.json`) ? bundled : fileURLToPath(new URL('../migrations', import.meta.url));
}

export const migrationsFolder = findMigrationsFolder();

/** Every release's migrator takes this session lock, so two deploys never migrate at once. */
const MIGRATION_LOCK = 7_206_120_001;

interface JournalEntry {
	tag: string;
	when: number;
}

export function readJournal(folder = migrationsFolder): JournalEntry[] {
	const journal = JSON.parse(readFileSync(`${folder}/meta/_journal.json`, 'utf8')) as { entries: JournalEntry[] };
	return journal.entries.map(({ tag, when }) => ({ tag, when }));
}

/**
 * Migrations Drizzle would apply: those newer than the last one recorded in
 * `app.__migrations` (its own rule), or every one when nothing is recorded.
 */
export function pendingMigrations(journal: JournalEntry[], lastAppliedAt: number | null): string[] {
	return journal.filter((entry) => lastAppliedAt === null || entry.when > lastAppliedAt).map((entry) => entry.tag);
}

type Sql = postgres.Sql;

async function lastAppliedAt(sql: Sql): Promise<number | null> {
	const [table] = await sql<{ exists: boolean }[]>`select to_regclass('app.__migrations') is not null as exists`;
	if (!table?.exists) return null;
	const [row] = await sql<{ at: string | null }[]>`select max(created_at)::text as at from app.__migrations`;
	return row?.at ? Number(row.at) : null;
}

/** Whether the database already has the platform's schema (a fresh database has nothing to back up). */
async function hasSchema(sql: Sql): Promise<boolean> {
	const [row] = await sql<{ exists: boolean }[]>`select exists (select 1 from information_schema.tables where table_schema = 'app') as exists`;
	return Boolean(row?.exists);
}

export interface MigrationPlan {
	pending: string[];
	/** The database has tables of the `app` schema, so its data is worth a dump before migrating. */
	hasData: boolean;
}

/**
 * Applies the pending migrations under a session advisory lock. `beforeMigrate`
 * runs while the lock is held and only when something is pending, so the
 * pre-migration backup of a release sees the schema it is about to change;
 * if it throws, nothing is migrated.
 */
export async function runMigrations(
	url: string,
	options: { beforeMigrate?: (plan: MigrationPlan) => Promise<void>; migrationsFolder?: string } = {}
): Promise<string[]> {
	const folder = options.migrationsFolder ?? migrationsFolder;
	// One connection: the lock, the check and Drizzle's statements share the session.
	const sql = postgres(url, { max: 1, onnotice: () => {} });
	try {
		await sql`select pg_advisory_lock(${MIGRATION_LOCK})`;
		const pending = pendingMigrations(readJournal(folder), await lastAppliedAt(sql));
		if (pending.length === 0) return [];
		await options.beforeMigrate?.({ pending, hasData: await hasSchema(sql) });
		await migrate(drizzle(sql), { migrationsFolder: folder, migrationsSchema: 'app', migrationsTable: '__migrations' });
		return pending;
	} finally {
		await sql.end();
	}
}
