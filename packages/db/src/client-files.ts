import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256Hex } from '@sortea/domain/server';
import { checksumRefusal, ClientPackRefusedError, declaredFiles, everyDeclaredFile, type ClientPack, type ClientPackResult, type ClientPackServices, type ProductFileSeed } from './client-pack';
import type { ScopedStore } from './object-store';

/**
 * Where the real product files of a client pack travel (README, "Client packs").
 *
 * `pnpm client:export` copies each file from the local bucket into
 * `clients/<client>/files/<sha256 prefix>-<filename>`, kept outside git. A
 * deployed database is private, so `client:load` runs inside its api service,
 * whose image has no such directory: `pnpm client:upload-files` first puts the
 * files in the environment's bucket as `product-assets/_incoming/<sha256>`, and
 * the load copies each one to its product, checking the sha256, then removes it.
 */

/** Under `product-assets/`: files on their way to a product, named by their full sha256. */
export const INCOMING_PREFIX = '_incoming/';

/** The file's name in `clients/<client>/files`. */
export function packFileName(file: ProductFileSeed): string {
	return `${file.sha256.slice(0, 16)}-${file.filename}`;
}

/** The file's path under `product-assets/` while it waits for `client:load`. */
export function incomingPath(file: ProductFileSeed): string {
	return `${INCOMING_PREFIX}${file.sha256}`;
}

export async function readAll(chunks: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
	const parts: Uint8Array[] = [];
	for await (const chunk of chunks) parts.push(chunk);
	return new Uint8Array(Buffer.concat(parts));
}

/**
 * Finds a declared file in the pack's files directory (`label` names it in
 * messages), else in the bucket's `_incoming/`. The loader checks the sha256.
 */
export function declaredFileReader(options: { dir: string; label: string; incoming?: ScopedStore }): NonNullable<ClientPackServices['readDeclaredFile']> {
	return async (_productSlug, file) => {
		const local = join(options.dir, packFileName(file));
		if (existsSync(local)) return { bytes: new Uint8Array(await readFile(local)), source: 'local', location: `${options.label}/${packFileName(file)}` };
		const incoming = options.incoming;
		if (incoming && (await incoming.exists(incomingPath(file)))) {
			return { bytes: await readAll(await incoming.getStream(incomingPath(file))), source: 'incoming', location: `bucket ${incoming.prefix}${incomingPath(file)}` };
		}
		return null;
	};
}

export interface IncomingUpload {
	productSlug: string;
	filename: string;
	sizeBytes: number;
	/** Under `product-assets/`. */
	path: string;
	/** `present`: an earlier run already uploaded it. */
	outcome: 'uploaded' | 'present';
}

/**
 * Uploads every file the pack declares from `dir` to `_incoming/`. Every file
 * is checked against its sha256 before any is uploaded; a file already there
 * is not uploaded again.
 */
export async function uploadIncomingFiles(pack: ClientPack, dir: string, files: ScopedStore): Promise<IncomingUpload[]> {
	const checked: { productSlug: string; file: ProductFileSeed; bytes: Uint8Array }[] = [];
	for (const { productSlug, file } of everyDeclaredFile(pack)) {
		const path = join(dir, packFileName(file));
		if (!existsSync(path)) {
			throw new ClientPackRefusedError(`${productSlug}: no ${packFileName(file)} in the pack's files directory; run pnpm client:export ${pack.slug} on the machine with the local database.`);
		}
		const bytes = new Uint8Array(await readFile(path));
		const actual = sha256Hex(bytes);
		if (actual !== file.sha256) throw checksumRefusal(productSlug, packFileName(file), actual, file.sha256);
		checked.push({ productSlug, file, bytes });
	}
	const uploads: IncomingUpload[] = [];
	for (const { productSlug, file, bytes } of checked) {
		const path = incomingPath(file);
		const present = await files.exists(path);
		if (!present) await files.put(path, bytes, { contentType: file.contentType });
		uploads.push({ productSlug, filename: file.filename, sizeBytes: bytes.byteLength, path, outcome: present ? 'present' : 'uploaded' });
	}
	return uploads;
}

/** Removes the `_incoming/` copies a load used; their bytes now live under their product. */
export async function removeIncomingFiles(files: ScopedStore, pack: ClientPack, result: ClientPackResult): Promise<string[]> {
	const paths = (result.files ?? [])
		.filter((placed) => placed.source === 'incoming')
		.map((placed) => incomingPath(declaredFiles(pack, placed.productSlug).find((file) => file.filename === placed.filename)!));
	if (paths.length > 0) await files.remove(paths);
	return paths;
}
