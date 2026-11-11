import { listBackups } from '../backup-runner';
import { BackupRefusedError, backupScheduleFromEnv } from '../backups';
import { createObjectStore, objectStoreConfigFromEnv, ObjectStoreConfigError } from '../object-store';

/**
 * Lists the dumps of `backups/<DEPLOY_ENVIRONMENT>/` in the bucket of the S3
 * variables, newest first (README, "Backups"):
 *
 *   pnpm db:backups
 */
try {
	const { environment } = backupScheduleFromEnv(process.env);
	const store = createObjectStore(objectStoreConfigFromEnv());
	const backups = await listBackups(store, environment);
	console.log(`Bucket: ${store.location}  Environment: ${environment}  Dumps: ${backups.length}`);
	for (const backup of backups) console.log(`${backup.at.toISOString()}  ${backup.reason.padEnd(11)}  ${backup.key}${backup.complete ? '' : '  (no checksum: incomplete, restore refuses it)'}`);
} catch (error) {
	console.error(error instanceof BackupRefusedError || error instanceof ObjectStoreConfigError ? error.message : error instanceof Error ? error.message : error);
	process.exitCode = 1;
}
