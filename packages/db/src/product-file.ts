import { createHash } from 'node:crypto';
import {
	hasProductFileExtension,
	PRODUCT_FILES_MAX,
	productFileKinds,
	productFileKindsLabel,
	safeProductFilename,
	sniffProductFile,
	type ProductFileKind
} from '@sortea/domain';
import { asc, count, eq, inArray } from 'drizzle-orm';
import type { DatabaseHandle, Tx } from './client';
import * as s from './schema';

/**
 * Puts a tenant's real files behind a digital product (FR-COM-01, FR-COM-05),
 * in any environment: `pnpm db:product-file` runs it with that environment's
 * database and storage credentials, the back office adds, replaces and removes
 * them one at a time, and `client:load --catalog` makes them match a pack.
 *
 * A product may hold several files, each with its own download link, in order
 * (owner-feedback-2026-11-11b, S2). A replaced file keeps its asset row, so the
 * download links buyers already received deliver the new file. Objects are
 * named by their hash, so an upload never overwrites the file a link may be
 * serving right now; the previous object is deleted only after no row points
 * to it and the download URLs signed for it have expired. A run whose row is
 * current but whose object is missing from storage uploads it again.
 */

/**
 * How long the previous file stays after a replacement: download URLs are signed
 * for 60 seconds (SIGNED_URL_SECONDS in apps/api/src/modules/downloads.ts), so a
 * buyer whose link was exchanged just before the swap still gets the file.
 */
export const PREVIOUS_FILE_GRACE_MS = 65_000;

/** Product files: paths under `product-assets/` of the environment's bucket (ADR 0020). */
export interface ProductFileStorage {
	upload(path: string, bytes: Uint8Array, contentType: string): Promise<void>;
	exists(path: string): Promise<boolean>;
	remove(paths: string[]): Promise<void>;
}

export interface ProductFileOptions {
	/** Waits before the previous file is deleted; tests pass one that does not sleep. */
	sleep?: (ms: number) => Promise<void>;
}

/** Who changed the files, for the audit log; commands run as `system`. */
export interface ProductFileActor {
	actorType: 'admin' | 'platform_admin' | 'system';
	actorId?: string | null;
}

/** Why a file was refused; the back office words each one in Spanish. */
export type ProductFileRefusal = 'unsupported' | 'extension' | 'name' | 'organization' | 'product' | 'physical' | 'several' | 'duplicate' | 'too_many' | 'file';

export class ProductFileRefusedError extends Error {
	constructor(
		message: string,
		readonly code: ProductFileRefusal = 'file',
		/** For `duplicate`: the download name of the file the product already has. */
		readonly existing?: string
	) {
		super(message);
	}
}

export interface ProductFileInput {
	organizationSlug: string;
	productSlug: string;
	/** Name the buyer's download gets. */
	filename: string;
	bytes: Uint8Array;
}

export interface ProductFileResult {
	/** `restored`: the product already pointed to this file, but storage had lost it. */
	outcome: 'added' | 'replaced' | 'unchanged' | 'restored';
	organizationId: string;
	productId: string;
	assetId: string;
	storagePath: string;
	sizeBytes: number;
	/** Set when the previous file could not be deleted from storage; remove it by hand. */
	staleFile?: { path: string; error: string };
}

export { productFileKinds };
/** Download names: plain ASCII, so they survive Content-Disposition and every mail client unchanged. */
export const safeFilename = safeProductFilename;

const systemActor: ProductFileActor = { actorType: 'system' };
const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A file checked for delivery: its kind by its bytes, a download name that matches it. */
interface CheckedFile {
	filename: string;
	bytes: Uint8Array;
	kind: ProductFileKind;
	sha256: string;
	sizeBytes: number;
}

export function checkProductFile(filename: string, bytes: Uint8Array): CheckedFile {
	const kind = sniffProductFile(bytes);
	if (!kind) throw new ProductFileRefusedError(`${filename} is not ${productFileKindsLabel} file`, 'unsupported');
	if (!hasProductFileExtension(filename, kind)) {
		throw new ProductFileRefusedError(`${filename} is ${kind.label}; name it with the .${kind.extension} extension`, 'extension');
	}
	if (!safeProductFilename.test(filename)) {
		throw new ProductFileRefusedError(`Download name ${filename} may only use letters A-Z, digits, dots, dashes and underscores`, 'name');
	}
	return { filename, bytes, kind, sha256: createHash('sha256').update(bytes).digest('hex'), sizeBytes: bytes.byteLength };
}

/** Where a product's file lives under `product-assets/`, named by its hash. */
export function productFilePath(organizationId: string, productId: string, sha256: string, kind: Pick<ProductFileKind, 'extension'>): string {
	return `${organizationId}/${productId}/${sha256.slice(0, 16)}.${kind.extension}`;
}

type AssetRow = typeof s.productAssets.$inferSelect;

async function productAndFiles(tx: Tx, productId: string, lock: boolean) {
	const query = tx.select({ id: s.products.id, slug: s.products.slug, kind: s.products.kind }).from(s.products).where(eq(s.products.id, productId));
	const [product] = lock ? await query.for('update') : await query;
	if (!product) throw new ProductFileRefusedError('No such product', 'product');
	if (product.kind !== 'digital') throw new ProductFileRefusedError(`${product.slug} is a physical product; only digital products deliver files`, 'physical');
	const assets = await tx.select().from(s.productAssets).where(eq(s.productAssets.productId, productId)).orderBy(asc(s.productAssets.position), asc(s.productAssets.createdAt));
	return { product, assets };
}

function auditFile(tx: Tx, organizationId: string, productId: string, actor: ProductFileActor, action: string, metadata: Record<string, unknown>) {
	return tx.insert(s.auditEvents).values({ organizationId, actorType: actor.actorType, actorId: actor.actorId ?? null, action, targetType: 'product', targetId: productId, metadata });
}

const fileMetadata = (file: CheckedFile) => ({ filename: file.filename, sizeBytes: file.sizeBytes, sha256: file.sha256 });
const previousOf = (asset: AssetRow) => ({ previous: { filename: asset.filename, sizeBytes: asset.sizeBytes } });
const assetValues = (file: CheckedFile, storagePath: string) => ({ storagePath, filename: file.filename, contentType: file.kind.contentType, sizeBytes: file.sizeBytes });

/**
 * Whether a product row points to the object, read now. If the read fails it answers yes, so the
 * object stays: an orphan file is harmless, a row pointing to nothing is not.
 */
async function isReferenced(handle: DatabaseHandle, organizationId: string, storagePath: string): Promise<boolean> {
	return handle
		.withTenant(organizationId, (tx) => tx.select({ id: s.productAssets.id }).from(s.productAssets).where(eq(s.productAssets.storagePath, storagePath)))
		.then((rows) => rows.length > 0)
		.catch(() => true);
}

/** After a failed write: removes the uploaded objects no row points to. */
async function discardUploads(handle: DatabaseHandle, storage: ProductFileStorage, organizationId: string, paths: string[]) {
	for (const path of paths) if (!(await isReferenced(handle, organizationId, path))) await storage.remove([path]).catch(() => undefined);
}

/**
 * Deletes an object a product no longer points to, once the download URLs signed for it expired
 * (PREVIOUS_FILE_GRACE_MS). It stays when a row points to it again by then. Returns the error when
 * storage refused, so the caller can tell a person to delete it by hand.
 */
export async function removeUnreferencedFile(
	handle: DatabaseHandle,
	storage: ProductFileStorage,
	organizationId: string,
	storagePath: string,
	options: ProductFileOptions = {}
): Promise<{ path: string; error: string } | undefined> {
	return (await removeUnreferencedFiles(handle, storage, organizationId, [storagePath], options))[0];
}

async function removeUnreferencedFiles(handle: DatabaseHandle, storage: ProductFileStorage, organizationId: string, paths: string[], options: ProductFileOptions) {
	if (paths.length === 0) return [];
	await (options.sleep ?? realSleep)(PREVIOUS_FILE_GRACE_MS);
	const stale: { path: string; error: string }[] = [];
	const unreferenced: string[] = [];
	for (const path of new Set(paths)) if (!(await isReferenced(handle, organizationId, path))) unreferenced.push(path);
	if (unreferenced.length === 0) return stale;
	try {
		await storage.remove(unreferenced);
	} catch (error) {
		for (const path of unreferenced) stale.push({ path, error: error instanceof Error ? error.message : String(error) });
	}
	return stale;
}

export interface ProductFileChange {
	organizationId: string;
	productId: string;
	/** Name the buyer's download gets. */
	filename: string;
	bytes: Uint8Array;
	actor?: ProductFileActor;
}

/** Adds a file after the ones the product has (the back office's "Agregar archivo"). */
export async function addProductFile(
	handle: DatabaseHandle,
	storage: ProductFileStorage,
	input: ProductFileChange
): Promise<{ outcome: 'added'; assetId: string; storagePath: string; sizeBytes: number; position: number }> {
	const file = checkProductFile(input.filename, input.bytes);
	const { organizationId, productId } = input;
	const storagePath = productFilePath(organizationId, productId, file.sha256, file.kind);
	const refuseAdding = (product: { slug: string }, assets: AssetRow[]) => {
		const same = assets.find((asset) => asset.storagePath === storagePath);
		if (same) throw new ProductFileRefusedError(`${product.slug} already has this file, as ${same.filename}`, 'duplicate', same.filename);
		if (assets.length >= PRODUCT_FILES_MAX) throw new ProductFileRefusedError(`${product.slug} already has ${assets.length} files, the most a product delivers`, 'too_many');
	};
	const before = await handle.withTenant(organizationId, (tx) => productAndFiles(tx, productId, false));
	refuseAdding(before.product, before.assets);

	await storage.upload(storagePath, file.bytes, file.kind.contentType);
	try {
		return await handle.withTenant(organizationId, async (tx) => {
			// Read again under the product's row lock: another change may have landed during the upload.
			const { product, assets } = await productAndFiles(tx, productId, true);
			refuseAdding(product, assets);
			const position = assets.reduce((last, asset) => Math.max(last, asset.position + 1), 0);
			const [row] = await tx
				.insert(s.productAssets)
				.values({ organizationId, productId, position, ...assetValues(file, storagePath) })
				.returning({ id: s.productAssets.id });
			await auditFile(tx, organizationId, productId, input.actor ?? systemActor, 'product.file_added', fileMetadata(file));
			return { outcome: 'added' as const, assetId: row!.id, storagePath, sizeBytes: file.sizeBytes, position };
		});
	} catch (error) {
		await discardUploads(handle, storage, organizationId, [storagePath]);
		throw error;
	}
}

/**
 * Replaces one file of the product in place: same row, so its download links already sent deliver
 * the new file. Returns the previous object for `removeUnreferencedFile`, which the caller runs
 * once the URLs signed for it expired.
 */
export async function replaceProductFileAsset(
	handle: DatabaseHandle,
	storage: ProductFileStorage,
	input: ProductFileChange & { assetId: string }
): Promise<{ outcome: 'replaced' | 'unchanged' | 'restored'; assetId: string; storagePath: string; sizeBytes: number; previous: string | null }> {
	const file = checkProductFile(input.filename, input.bytes);
	const { organizationId, productId, assetId } = input;
	const actor = input.actor ?? systemActor;
	const storagePath = productFilePath(organizationId, productId, file.sha256, file.kind);
	const target = (product: { slug: string }, assets: AssetRow[]) => {
		const asset = assets.find((entry) => entry.id === assetId);
		if (!asset) throw new ProductFileRefusedError(`${product.slug} has no such file`, 'file');
		const other = assets.find((entry) => entry.id !== assetId && entry.storagePath === storagePath);
		if (other) throw new ProductFileRefusedError(`${product.slug} already has this file, as ${other.filename}`, 'duplicate', other.filename);
		return asset;
	};
	const before = await handle.withTenant(organizationId, (tx) => productAndFiles(tx, productId, false));
	const current = target(before.product, before.assets);
	const base = { assetId, storagePath, sizeBytes: file.sizeBytes };
	if (current.storagePath === storagePath && current.filename === file.filename) {
		if (await storage.exists(storagePath)) return { ...base, outcome: 'unchanged', previous: null };
		await storage.upload(storagePath, file.bytes, file.kind.contentType);
		await handle.withTenant(organizationId, (tx) => auditFile(tx, organizationId, productId, actor, 'product.file_restored', fileMetadata(file)));
		return { ...base, outcome: 'restored', previous: null };
	}

	await storage.upload(storagePath, file.bytes, file.kind.contentType);
	try {
		return await handle.withTenant(organizationId, async (tx) => {
			const { product, assets } = await productAndFiles(tx, productId, true);
			const asset = target(product, assets);
			await tx.update(s.productAssets).set(assetValues(file, storagePath)).where(eq(s.productAssets.id, asset.id));
			await auditFile(tx, organizationId, productId, actor, 'product.file_replaced', { ...fileMetadata(file), ...previousOf(asset) });
			return { ...base, outcome: 'replaced' as const, previous: asset.storagePath === storagePath ? null : asset.storagePath };
		});
	} catch (error) {
		await discardUploads(handle, storage, organizationId, [storagePath]);
		throw error;
	}
}

/** Deletes a file's download links and its row; buyers who had a link to it lose it. */
async function deleteAsset(tx: Tx, asset: AssetRow): Promise<number> {
	const grants = await tx.select({ value: count() }).from(s.downloadGrants).where(eq(s.downloadGrants.productAssetId, asset.id));
	await tx.delete(s.downloadGrants).where(eq(s.downloadGrants.productAssetId, asset.id));
	await tx.delete(s.productAssets).where(eq(s.productAssets.id, asset.id));
	return grants[0]?.value ?? 0;
}

/**
 * Removes one file from the product, with its download links (the email's buttons and the ones
 * Consultar issued for it stop working). The object stays in storage: the caller deletes it with
 * `removeUnreferencedFile` once the URLs signed for it expired.
 */
export async function removeProductFileAsset(
	handle: DatabaseHandle,
	input: { organizationId: string; productId: string; assetId: string; actor?: ProductFileActor }
): Promise<{ assetId: string; filename: string; storagePath: string; grants: number }> {
	const { organizationId, productId, assetId } = input;
	return handle.withTenant(organizationId, async (tx) => {
		const { product, assets } = await productAndFiles(tx, productId, true);
		const asset = assets.find((entry) => entry.id === assetId);
		if (!asset) throw new ProductFileRefusedError(`${product.slug} has no such file`, 'file');
		const grants = await deleteAsset(tx, asset);
		await auditFile(tx, organizationId, productId, input.actor ?? systemActor, 'product.file_removed', { filename: asset.filename, sizeBytes: asset.sizeBytes, grants });
		return { assetId, filename: asset.filename, storagePath: asset.storagePath, grants };
	});
}

/** The one cross-tenant step: resolving a slug to its organization. */
async function organizationOf(handle: DatabaseHandle, organizationSlug: string): Promise<string> {
	const [organization] = await handle.withPlatform((db) =>
		db.select({ id: s.organizations.id }).from(s.organizations).where(eq(s.organizations.slug, organizationSlug))
	);
	if (!organization) throw new ProductFileRefusedError(`Unknown organization ${organizationSlug}`, 'organization');
	return organization.id;
}

async function productBySlug(tx: Tx, organizationSlug: string, productSlug: string, lock = false) {
	const query = tx.select({ id: s.products.id, kind: s.products.kind }).from(s.products).where(eq(s.products.slug, productSlug));
	const [product] = lock ? await query.for('update') : await query;
	if (!product) throw new ProductFileRefusedError(`Organization ${organizationSlug} has no product ${productSlug}`, 'product');
	if (product.kind !== 'digital') throw new ProductFileRefusedError(`${productSlug} is a physical product; only digital products deliver files`, 'physical');
	return product;
}

/**
 * The product's one file, from `pnpm db:product-file`: added when it has none, replaced in place
 * when it has one. A product with several files is refused: those change one by one in the back
 * office, or as a list in a client pack.
 */
export async function replaceProductFile(
	handle: DatabaseHandle,
	storage: ProductFileStorage,
	input: ProductFileInput,
	options: ProductFileOptions = {}
): Promise<ProductFileResult> {
	const file = checkProductFile(input.filename, input.bytes);
	const organizationId = await organizationOf(handle, input.organizationSlug);

	const current = await handle.withTenant(organizationId, (tx) => productWithFile(tx, input));
	const storagePath = productFilePath(organizationId, current.product.id, file.sha256, file.kind);
	const base = { organizationId, productId: current.product.id, storagePath, sizeBytes: file.sizeBytes };
	if (current.asset?.storagePath === storagePath && current.asset.filename === input.filename) {
		if (await storage.exists(storagePath)) return { ...base, outcome: 'unchanged', assetId: current.asset.id };
		// The row is right but the object is gone: put the same bytes back under the same name.
		await storage.upload(storagePath, file.bytes, file.kind.contentType);
		await handle.withTenant(organizationId, (tx) => auditFile(tx, organizationId, current.product.id, systemActor, 'product.file_restored', fileMetadata(file)));
		return { ...base, outcome: 'restored', assetId: current.asset.id };
	}

	await storage.upload(storagePath, file.bytes, file.kind.contentType);
	let written: { outcome: 'added' | 'replaced'; assetId: string; previous: string | null };
	try {
		written = await handle.withTenant(organizationId, async (tx) => {
			// Read again under the product's row lock, which serializes concurrent runs: the state may
			// have changed during the upload.
			const { product, asset } = await productWithFile(tx, input, true);
			if (asset) {
				await tx.update(s.productAssets).set(assetValues(file, storagePath)).where(eq(s.productAssets.id, asset.id));
				await auditFile(tx, organizationId, product.id, systemActor, 'product.file_replaced', { ...fileMetadata(file), ...previousOf(asset) });
				return { outcome: 'replaced', assetId: asset.id, previous: asset.storagePath === storagePath ? null : asset.storagePath };
			}
			const [row] = await tx.insert(s.productAssets).values({ organizationId, productId: product.id, ...assetValues(file, storagePath) }).returning({ id: s.productAssets.id });
			await auditFile(tx, organizationId, product.id, systemActor, 'product.file_added', fileMetadata(file));
			return { outcome: 'added', assetId: row!.id, previous: null };
		});
	} catch (error) {
		// Remove the new object only if no row points to it. The read before the upload is not
		// enough: another run may have put the same file in place meanwhile, or the write may have
		// committed before the error.
		await discardUploads(handle, storage, organizationId, [storagePath]);
		throw error;
	}

	const result: ProductFileResult = { ...base, outcome: written.outcome, assetId: written.assetId };
	if (written.previous) {
		// Another run may have made it the product's file again during the wait.
		const [stale] = await removeUnreferencedFiles(handle, storage, organizationId, [written.previous], options);
		if (stale) result.staleFile = stale;
	}
	return result;
}

async function productWithFile(tx: Tx, input: ProductFileInput, lock = false) {
	const product = await productBySlug(tx, input.organizationSlug, input.productSlug, lock);
	const assets = await tx.select().from(s.productAssets).where(eq(s.productAssets.productId, product.id));
	if (assets.length > 1) {
		throw new ProductFileRefusedError(
			`${input.productSlug} has ${assets.length} files; this command replaces exactly one. Add or remove each of its files in the back office (Productos, "Archivos para descargar"), or list them under files.${input.productSlug} of the client pack and run pnpm client:load ${input.organizationSlug} --update --catalog`,
			'several'
		);
	}
	return { product, asset: assets[0] ?? null };
}

export interface ProductFilesInput {
	organizationSlug: string;
	productSlug: string;
	/** In the order buyers see them. */
	files: { filename: string; bytes: Uint8Array }[];
}

export interface ProductFilesResult {
	organizationId: string;
	productId: string;
	/** One per listed file, in order, then one per file the list left out. */
	changes: { filename: string; outcome: 'added' | 'replaced' | 'unchanged' | 'restored' | 'moved' | 'removed' }[];
	/** Previous files that could not be deleted from storage; remove them by hand. */
	staleFiles: { path: string; error: string }[];
}

/**
 * Makes a product's files the list, in its order (a client pack's `files`, `client:load --catalog`).
 * A file the product already has keeps its row; a new file takes the row of one the list left out,
 * in order, so the links already sent for it deliver the new file; the rest are added, and the
 * files left over are removed with their links.
 */
export async function syncProductFiles(
	handle: DatabaseHandle,
	storage: ProductFileStorage,
	input: ProductFilesInput,
	options: ProductFileOptions = {}
): Promise<ProductFilesResult> {
	const files = input.files.map((entry) => checkProductFile(entry.filename, entry.bytes));
	for (const [index, file] of files.entries()) {
		const first = files.findIndex((other) => other.sha256 === file.sha256);
		if (first < index) throw new ProductFileRefusedError(`${file.filename} is the same file as ${files[first]!.filename}`, 'duplicate');
	}
	if (files.length > PRODUCT_FILES_MAX) throw new ProductFileRefusedError(`${input.productSlug}: ${files.length} files; a product delivers at most ${PRODUCT_FILES_MAX}`, 'too_many');
	const organizationId = await organizationOf(handle, input.organizationSlug);
	const product = await handle.withTenant(organizationId, (tx) => productBySlug(tx, input.organizationSlug, input.productSlug));
	const targets = files.map((file) => ({ ...file, storagePath: productFilePath(organizationId, product.id, file.sha256, file.kind) }));

	// Upload what storage lacks before writing rows: an orphan object is harmless, a row without its object is not.
	const uploaded = new Set<string>();
	for (const target of targets) {
		if (await storage.exists(target.storagePath)) continue;
		await storage.upload(target.storagePath, target.bytes, target.kind.contentType);
		uploaded.add(target.storagePath);
	}

	let written: { changes: ProductFilesResult['changes']; previous: string[] };
	try {
		written = await handle.withTenant(organizationId, async (tx) => {
			await productBySlug(tx, input.organizationSlug, input.productSlug, true);
			const assets = await tx.select().from(s.productAssets).where(eq(s.productAssets.productId, product.id)).orderBy(asc(s.productAssets.position), asc(s.productAssets.createdAt));
			const kept = targets.map((target) => assets.find((asset) => asset.storagePath === target.storagePath) ?? null);
			const spare = assets.filter((asset) => !kept.includes(asset));
			const changes: ProductFilesResult['changes'] = [];
			const previous: string[] = [];
			for (const [position, file] of targets.entries()) {
				const asset = kept[position];
				if (asset) {
					const values = { filename: file.filename, position };
					if (asset.filename !== file.filename) {
						await tx.update(s.productAssets).set(values).where(eq(s.productAssets.id, asset.id));
						await auditFile(tx, organizationId, product.id, systemActor, 'product.file_replaced', { ...fileMetadata(file), ...previousOf(asset) });
						changes.push({ filename: file.filename, outcome: 'replaced' });
					} else if (uploaded.has(file.storagePath)) {
						if (asset.position !== position) await tx.update(s.productAssets).set(values).where(eq(s.productAssets.id, asset.id));
						await auditFile(tx, organizationId, product.id, systemActor, 'product.file_restored', fileMetadata(file));
						changes.push({ filename: file.filename, outcome: 'restored' });
					} else if (asset.position !== position) {
						await tx.update(s.productAssets).set(values).where(eq(s.productAssets.id, asset.id));
						changes.push({ filename: file.filename, outcome: 'moved' });
					} else {
						changes.push({ filename: file.filename, outcome: 'unchanged' });
					}
					continue;
				}
				const reused = spare.shift();
				if (reused) {
					await tx.update(s.productAssets).set({ ...assetValues(file, file.storagePath), position }).where(eq(s.productAssets.id, reused.id));
					await auditFile(tx, organizationId, product.id, systemActor, 'product.file_replaced', { ...fileMetadata(file), ...previousOf(reused) });
					previous.push(reused.storagePath);
					changes.push({ filename: file.filename, outcome: 'replaced' });
				} else {
					await tx.insert(s.productAssets).values({ organizationId, productId: product.id, position, ...assetValues(file, file.storagePath) });
					await auditFile(tx, organizationId, product.id, systemActor, 'product.file_added', fileMetadata(file));
					changes.push({ filename: file.filename, outcome: 'added' });
				}
			}
			for (const asset of spare) {
				const grants = await deleteAsset(tx, asset);
				await auditFile(tx, organizationId, product.id, systemActor, 'product.file_removed', { filename: asset.filename, sizeBytes: asset.sizeBytes, grants });
				previous.push(asset.storagePath);
				changes.push({ filename: asset.filename, outcome: 'removed' });
			}
			return { changes, previous };
		});
	} catch (error) {
		await discardUploads(handle, storage, organizationId, [...uploaded]);
		throw error;
	}
	const staleFiles = await removeUnreferencedFiles(handle, storage, organizationId, written.previous, options);
	return { organizationId, productId: product.id, changes: written.changes, staleFiles };
}

/** The files of the products, in the order buyers see them (the paid email, Consultar). */
export function productFilesInOrder(tx: Tx, productIds: string[]) {
	return tx
		.select()
		.from(s.productAssets)
		.where(inArray(s.productAssets.productId, productIds))
		.orderBy(asc(s.productAssets.position), asc(s.productAssets.createdAt));
}
