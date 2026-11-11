import { pruneBackups, takeBackup } from '../backup-runner';
import { BACKUP_REASONS, BackupRefusedError, backupScheduleFromEnv, describeDatabase, type BackupReason } from '../backups';
import { createObjectStore, objectStoreConfigFromEnv, ObjectStoreConfigError } from '../object-store';
import { databaseUrl } from './env';

/**
 * Dumps the database at DATABASE_URL into `backups/<DEPLOY_ENVIRONMENT>/` of
 * the bucket of the S3 variables, then applies the retention (ADR 0020,
 * "Backups of our own"; README, "Backups"):
 *
 *   pnpm db:backup [--reason manual|nightly|pre-migrate]
 *
 * The reason defaults to `manual`. It prints the database (host and name),
 * the key, the size and the SHA-256; never a credential.
 */
try {
	const args = process.argv.slice(2);
	let reason: BackupReason = 'manual';
	if (args[0] === '--reason' && (BACKUP_REASONS as readonly string[]).includes(args[1] ?? '') && args.length === 2) reason = args[1] as BackupReason;
	else if (args.length > 0) throw new BackupRefusedError(`Usage: pnpm db:backup [--reason ${BACKUP_REASONS.join('|')}]`);
	const url = databaseUrl();
	const { environment } = backupScheduleFromEnv(process.env);
	const store = createObjectStore(objectStoreConfigFromEnv());
	console.log(`Database: ${describeDatabase(url)}  Bucket: ${store.location}  Environment: ${environment}`);
	const result = await takeBackup({ databaseUrl: url, store, environment, reason, now: new Date() });
	console.log(`Backup ${result.key}: ${result.bytes} bytes, sha256 ${result.sha256}`);
	const pruned = await pruneBackups(store, environment, new Date());
	if (pruned.length > 0) console.log(`Retention removed ${pruned.length} old dumps: ${pruned.join(', ')}`);
} catch (error) {
	console.error(error instanceof BackupRefusedError || error instanceof ObjectStoreConfigError ? error.message : error instanceof Error ? error.message : error);
	process.exitCode = 1;
}
