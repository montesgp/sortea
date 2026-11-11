import { pruneBackups, takeBackup } from '../backup-runner';
import { backupScheduleFromEnv, describeDatabase } from '../backups';
import { runMigrations } from '../migrator';
import { createObjectStore, objectStoreConfigFromEnv } from '../object-store';
import { databaseUrl } from './env';

/**
 * The API's pre-deploy command (ADR 0020, "Database"): a release starts only
 * after this exits 0.
 *
 * Under the migrator's advisory lock, when migrations are pending on a
 * database that already has the schema, it first dumps the database as a
 * `pre-migrate` backup into the bucket (S3 variables, DEPLOY_ENVIRONMENT),
 * then migrates. A failed backup or migration exits 1 and the deploy stops.
 * `PREMIGRATE_BACKUP=false` skips the dump, for a host whose database has
 * backups of its own.
 */
const url = databaseUrl();
try {
	console.log(`Pre-deploy: database ${describeDatabase(url)}`);
	const applied = await runMigrations(url, {
		async beforeMigrate(plan) {
			console.log(`Pending migrations: ${plan.pending.join(', ')}`);
			if (!plan.hasData) return console.log('Fresh database: no pre-migration backup needed.');
			if (process.env.PREMIGRATE_BACKUP === 'false') return console.log('PREMIGRATE_BACKUP=false: no pre-migration backup.');
			const { environment } = backupScheduleFromEnv(process.env);
			const store = createObjectStore(objectStoreConfigFromEnv());
			const backup = await takeBackup({ databaseUrl: url, store, environment, reason: 'pre-migrate', now: new Date() });
			console.log(`Pre-migration backup ${backup.key}: ${backup.bytes} bytes, sha256 ${backup.sha256}`);
			await pruneBackups(store, environment, new Date()).catch((error: unknown) => console.warn('Retention skipped:', error instanceof Error ? error.message : error));
		}
	});
	console.log(applied.length > 0 ? `Migrations applied: ${applied.join(', ')}` : 'Migrations: none pending');
} catch (error) {
	console.error('Pre-deploy failed; the release does not start:', error instanceof Error ? error.message : error);
	process.exitCode = 1;
}
