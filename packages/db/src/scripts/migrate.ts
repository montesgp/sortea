import { fileURLToPath } from 'node:url';
import { runMigrations } from '../migrator';
import { databaseUrl } from './env';

export { migrationsFolder, runMigrations } from '../migrator';

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	const applied = await runMigrations(databaseUrl());
	console.log(applied.length > 0 ? `Migrations applied: ${applied.join(', ')}` : 'Migrations applied: none pending');
}
