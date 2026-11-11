import { resolve } from 'node:path';
import { createDatabase } from '../client';
import { assertExportTarget, ClientExportRefusedError, exportClientPack } from '../client-export';
import { ClientPackRefusedError } from '../client-pack';
import { createObjectStore, objectStoreConfigFromEnv, ObjectStoreConfigError, PRODUCT_ASSETS_PREFIX, scopedStore } from '../object-store';
import { clientFilesDir, clientPackPath } from './client-load-args';
import { databaseUrl } from './env';

/**
 * Writes a client's current content from the local database back into its
 * private pack (README, "Client packs"):
 *
 *   pnpm client:export <client>
 *
 * It reads the organization with the client's slug in a read-only transaction
 * and rewrites only the values of `clients/<client>/pack.ts` that differ:
 * name, order prefix, settings, theme, published CMS blocks, active products,
 * suggestions, site FAQs and `files`. Hosts, members and the campaign stay as
 * written. The real file of each digital product is copied from the local
 * bucket into `clients/<client>/files/` (kept outside git). It refuses any
 * database or bucket that is not on this machine.
 */
const usage = 'Usage: pnpm client:export <client>';
const repositoryRoot = resolve(import.meta.dirname, '../../../..');
const mebibytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;

const url = databaseUrl();
let handle: ReturnType<typeof createDatabase> | undefined;
try {
	const args = process.argv.slice(2);
	const [client] = args;
	if (!client || args.length > 1 || client.startsWith('-')) throw new ClientExportRefusedError(usage);
	if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(client)) throw new ClientExportRefusedError(`${client} is not a client name: use lowercase letters, digits and dashes.`);
	const storeConfig = objectStoreConfigFromEnv();
	assertExportTarget(url, storeConfig.endpoint);
	const packFile = clientPackPath(repositoryRoot, client);
	const bucket = createObjectStore(storeConfig);
	handle = createDatabase(url, { max: 1 });

	console.log(`Database: ${new URL(url).host}${new URL(url).pathname} (read only)  Storage: ${bucket.location}/${PRODUCT_ASSETS_PREFIX}`);
	const result = await exportClientPack(handle, { client, packFile, filesDir: clientFilesDir(repositoryRoot, client), productFiles: scopedStore(bucket, PRODUCT_ASSETS_PREFIX) });
	console.log(result.written ? `Rewrote clients/${client}/pack.ts:` : `clients/${client}/pack.ts is already current:`);
	for (const line of result.summary) console.log(`  ${line}`);
	for (const file of result.files) {
		console.log(`  file ${file.productSlug}: ${file.filename} (${mebibytes(file.sizeBytes)}, sha256 ${file.sha256}) ${file.copied ? 'copied to' : 'already in'} clients/${client}/files/`);
	}
} catch (error) {
	const known = error instanceof ClientExportRefusedError || error instanceof ClientPackRefusedError || error instanceof ObjectStoreConfigError;
	console.error(known ? (error as Error).message : error);
	process.exitCode = 1;
} finally {
	await handle?.close();
}
