import postgres from 'postgres';
import { runMigrations } from './migrator';

/**
 * Creates (or recreates) a disposable database next to the development one and
 * applies all migrations. Used by vitest global setups in every package that
 * needs a real Postgres: isolation is a database property, so it is tested
 * against a database, not a mock.
 */
/**
 * TEST_DATABASE_SUFFIX lets several checkouts (git worktrees) run their suites at once without
 * dropping each other's databases: sortea_test_api_t2, sortea_test_db_migrator_t3, ... Every
 * database a test creates is named through this.
 */
export function testDatabaseName(base: string): string {
	return `${base}${process.env.TEST_DATABASE_SUFFIX ? `_${process.env.TEST_DATABASE_SUFFIX}` : ''}`;
}

export async function prepareTestDatabase(base: string): Promise<string> {
	const name = testDatabaseName(base);
	const adminUrl = process.env.TEST_DATABASE_ADMIN_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
	if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`Invalid test database name ${name}`);
	const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
	try {
		await admin.unsafe(`drop database if exists ${name} with (force)`);
		await admin.unsafe(`create database ${name}`);
	} finally {
		await admin.end();
	}
	const url = new URL(adminUrl);
	url.pathname = `/${name}`;
	await runMigrations(url.toString());
	return url.toString();
}
