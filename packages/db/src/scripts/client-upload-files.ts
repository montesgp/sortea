import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { uploadIncomingFiles } from '../client-files';
import { ClientPackRefusedError, type ClientPack } from '../client-pack';
import { createObjectStore, objectStoreConfigFromEnv, ObjectStoreConfigError, PRODUCT_ASSETS_PREFIX, scopedStore } from '../object-store';
import { clientFilesDir, clientPackPath } from './client-load-args';

/**
 * Uploads a client pack's real product files to a deployed environment's
 * bucket, from the owner's machine, so `client:load` inside that environment's
 * api service can put them behind the products (README, "Client packs"):
 *
 *   pnpm client:upload-files <client>
 *
 * It reads `clients/<client>/files` (written by `pnpm client:export`), checks
 * every file against the sha256 the pack declares, and uploads each one as
 * `product-assets/_incoming/<sha256>` unless it is already there. It never
 * reads `.env`: the bucket comes only from the S3_* variables set in the
 * environment of the command, so a local value can never mix with a deployed
 * one. It needs no database.
 */
const usage = 'Usage: pnpm client:upload-files <client>   (with the target bucket in S3_ENDPOINT, S3_REGION, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_FORCE_PATH_STYLE)';
const repositoryRoot = resolve(import.meta.dirname, '../../../..');
const mebibytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;

try {
	const args = process.argv.slice(2);
	const [client] = args;
	if (!client || args.length > 1 || client.startsWith('-')) throw new ClientPackRefusedError(usage);
	if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(client)) throw new ClientPackRefusedError(`${client} is not a client name: use lowercase letters, digits and dashes.`);
	const { pack } = (await import(pathToFileURL(clientPackPath(repositoryRoot, client)).href)) as { pack: ClientPack };
	if (pack.slug !== client) throw new ClientPackRefusedError(`clients/${client}/pack.ts has the slug ${pack.slug}; the directory and the slug must match.`);
	if (Object.keys(pack.files ?? {}).length === 0) throw new ClientPackRefusedError(`clients/${client}/pack.ts declares no files; run pnpm client:export ${client} first.`);

	const bucket = createObjectStore(objectStoreConfigFromEnv());
	console.log(`Storage: ${bucket.location}/${PRODUCT_ASSETS_PREFIX}_incoming/`);
	const uploads = await uploadIncomingFiles(pack, clientFilesDir(repositoryRoot, client), scopedStore(bucket, PRODUCT_ASSETS_PREFIX));
	for (const upload of uploads) {
		console.log(`  ${upload.productSlug}: ${upload.filename} (${mebibytes(upload.sizeBytes)}) ${upload.outcome === 'uploaded' ? 'uploaded to' : 'already in'} ${PRODUCT_ASSETS_PREFIX}${upload.path}`);
	}
	console.log(`Now run client:load ${client} inside the environment's api service; it moves each file to its product.`);
} catch (error) {
	console.error(error instanceof ClientPackRefusedError || error instanceof ObjectStoreConfigError ? error.message : error);
	process.exitCode = 1;
}
