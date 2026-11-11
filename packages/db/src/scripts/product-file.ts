import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { createDatabase } from '../client';
import { createObjectStore, objectStoreConfigFromEnv, ObjectStoreConfigError, PRODUCT_ASSETS_PREFIX, scopedStore, type ObjectStore } from '../object-store';
import { ProductFileRefusedError, replaceProductFile, type ProductFileStorage } from '../product-file';
import { databaseUrl } from './env';

/**
 * Puts the real file behind a digital product, in the environment that
 * DATABASE_URL and the S3 variables (S3_ENDPOINT, S3_REGION, S3_BUCKET,
 * S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_FORCE_PATH_STYLE) point to
 * (README, "Product files"). Files go under `product-assets/` of the bucket.
 *
 *   pnpm db:product-file <organization-slug> <product-slug> <file> [--name <download-name>]
 *
 * The download name defaults to the file's name. Running it again with the same
 * file changes nothing.
 */
const usage = 'Usage: pnpm db:product-file <organization-slug> <product-slug> <file> [--name <download-name>]';

function parseArgs(argv: string[]) {
	const positional: string[] = [];
	let name: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (arg === '--name') {
			name = argv[++i];
			if (name === undefined) throw new ProductFileRefusedError(`--name needs the download name. ${usage}`);
		} else if (arg.startsWith('-')) {
			throw new ProductFileRefusedError(`Unexpected argument ${arg}. ${usage}`);
		} else {
			positional.push(arg);
		}
	}
	const [organizationSlug, productSlug, file] = positional;
	if (!organizationSlug || !productSlug || !file || positional.length > 3) throw new ProductFileRefusedError(usage);
	// pnpm runs the script inside packages/db; a relative path means the directory the command was typed in.
	return { organizationSlug, productSlug, file: resolve(process.env.INIT_CWD ?? process.cwd(), file), filename: name ?? basename(file) };
}

function bucket(): ObjectStore {
	try {
		return createObjectStore(objectStoreConfigFromEnv());
	} catch (error) {
		if (error instanceof ObjectStoreConfigError) throw new ProductFileRefusedError(error.message);
		throw error;
	}
}

/** The product files of the bucket, under `product-assets/`. */
function productFiles(store: ObjectStore): ProductFileStorage {
	const files = scopedStore(store, PRODUCT_ASSETS_PREFIX);
	return {
		upload: (path, bytes, contentType) => files.put(path, bytes, { contentType }),
		exists: (path) => files.exists(path),
		remove: (paths) => files.remove(paths)
	};
}

const mebibytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;

const url = databaseUrl();
const handle = createDatabase(url, { max: 1 });
try {
	const args = parseArgs(process.argv.slice(2));
	const store = bucket();
	const storage = productFiles(store);
	const bytes = await readFile(args.file).catch(() => {
		throw new ProductFileRefusedError(`Cannot read ${args.file}`);
	});
	console.log(`Database: ${new URL(url).host}  Storage: ${store.location}/${PRODUCT_ASSETS_PREFIX}`);
	const result = await replaceProductFile(
		handle,
		storage,
		{ organizationSlug: args.organizationSlug, productSlug: args.productSlug, filename: args.filename, bytes },
		{
			sleep: (ms) => {
				console.log(`The product now points to the new file. The previous one is deleted in ${ms / 1000} s, once download links already signed for it expire.`);
				return new Promise((resolve) => setTimeout(resolve, ms));
			}
		}
	);
	const what = `${args.organizationSlug}/${args.productSlug}: ${args.filename} (${mebibytes(result.sizeBytes)})`;
	console.log(
		{
			added: `Added ${what}`,
			replaced: `Replaced the file of ${what}; download links already sent deliver it`,
			unchanged: `Unchanged: ${what} is already the product's file`,
			restored: `Restored ${what}: the product pointed to it but storage had lost it; uploaded again`
		}[result.outcome]
	);
	console.log(`  storage path: ${result.storagePath}`);
	if (result.staleFile) {
		console.error(`The previous file could not be deleted (${result.staleFile.error}); delete ${PRODUCT_ASSETS_PREFIX}${result.staleFile.path} from bucket ${store.bucket} by hand.`);
		process.exitCode = 1;
	}
} catch (error) {
	console.error(error instanceof ProductFileRefusedError ? error.message : error);
	process.exitCode = 1;
} finally {
	await handle.close();
}
