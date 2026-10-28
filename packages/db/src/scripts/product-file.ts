import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { createDatabase } from '../client';
import { ProductFileRefusedError, replaceProductFile, type ProductFileStorage } from '../product-file';
import { databaseUrl } from './env';

/**
 * Puts the real file behind a digital product, in the environment that
 * DATABASE_URL, SUPABASE_URL and SUPABASE_SECRET_KEY point to
 * (README, "Product files").
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

function supabaseStorage(bucket: string): ProductFileStorage {
	const url = process.env.SUPABASE_URL;
	const secretKey = process.env.SUPABASE_SECRET_KEY;
	if (!url || !secretKey) throw new ProductFileRefusedError('Set SUPABASE_URL and SUPABASE_SECRET_KEY for the environment that receives the file.');
	const storage = createClient(url, secretKey, { auth: { persistSession: false, autoRefreshToken: false } }).storage.from(bucket);
	return {
		async upload(path, bytes, contentType) {
			const { error } = await storage.upload(path, bytes, { contentType, upsert: true });
			if (error) throw new Error(`Could not upload ${path} to ${bucket}: ${error.message}`);
		},
		async exists(path) {
			// false for a missing object (400/404); any other storage error throws.
			const { data } = await storage.exists(path);
			return data;
		},
		async remove(paths) {
			const { error } = await storage.remove(paths);
			if (error) throw new Error(error.message);
		}
	};
}

const mebibytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;

const url = databaseUrl();
const handle = createDatabase(url, { max: 1 });
try {
	const args = parseArgs(process.argv.slice(2));
	const bucket = process.env.STORAGE_BUCKET ?? 'product-assets';
	const storage = supabaseStorage(bucket);
	const bytes = await readFile(args.file).catch(() => {
		throw new ProductFileRefusedError(`Cannot read ${args.file}`);
	});
	console.log(`Database: ${new URL(url).host}  Storage: ${new URL(process.env.SUPABASE_URL!).host}/${bucket}`);
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
		console.error(`The previous file could not be deleted (${result.staleFile.error}); delete ${bucket}/${result.staleFile.path} by hand.`);
		process.exitCode = 1;
	}
} catch (error) {
	console.error(error instanceof ProductFileRefusedError ? error.message : error);
	process.exitCode = 1;
} finally {
	await handle.close();
}
