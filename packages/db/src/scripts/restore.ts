import { restoreBackup, restoreContext } from '../backup-runner';
import { BackupRefusedError, describeDatabase, parseRestoreArgs, restoreRefusal } from '../backups';
import { createObjectStore, objectStoreConfigFromEnv, ObjectStoreConfigError } from '../object-store';

/**
 * Restores a dump of the bucket of the S3 variables into a database (README,
 * "Backups"):
 *
 *   pnpm db:restore <key> --target <database URL> --confirm <database>@<server> [--i-know-this-is-production]
 *
 * It replaces the target's `app` schema in one transaction. It asks the
 * target who it is first: `--confirm` must repeat its database name and the
 * last 6 digits of its server's system identifier, which the refusal prints,
 * so staging and production (both `railway`) need different confirmations.
 * It refuses the production environment's own database (DATABASE_URL with
 * DEPLOY_ENVIRONMENT=production, recognised by server identity under any host
 * spelling) without `--i-know-this-is-production`. It prints the target's
 * host and name, never its credentials.
 */
try {
	const args = parseRestoreArgs(process.argv.slice(2));
	// The key and the URL are checked before connecting to anything; the confirmation once the target answered.
	const early = restoreRefusal({ ...args, confirm: undefined }, {});
	if (early && !early.includes('--confirm')) throw new BackupRefusedError(early);
	const { context, notes } = await restoreContext(args, process.env);
	for (const note of notes) console.warn(note);
	const refusal = restoreRefusal(args, context);
	if (refusal) throw new BackupRefusedError(refusal);
	const store = createObjectStore(objectStoreConfigFromEnv());
	console.log(`Restoring ${args.key} from ${store.location} into ${describeDatabase(args.target)}`);
	const result = await restoreBackup({ store, key: args.key, targetUrl: args.target });
	console.log(`Restored ${result.bytes} bytes (sha256 ${result.sha256}). Run the migrations against the target if the dump is older than this release.`);
} catch (error) {
	console.error(error instanceof BackupRefusedError || error instanceof ObjectStoreConfigError ? error.message : error instanceof Error ? error.message : error);
	process.exitCode = 1;
}
