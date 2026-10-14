import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { databaseUrl } from './env';

export const migrationsFolder = fileURLToPath(new URL('../../migrations', import.meta.url));

export async function runMigrations(url: string): Promise<void> {
	const client = postgres(url, { max: 1, onnotice: () => {} });
	try {
		await migrate(drizzle(client), { migrationsFolder, migrationsSchema: 'app', migrationsTable: '__migrations' });
	} finally {
		await client.end();
	}
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	await runMigrations(databaseUrl());
	console.log('Migrations applied');
}
