import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { DatabaseHandle, Tx } from './client';
import * as s from './schema';

/**
 * Puts a tenant's real file behind a digital product (FR-COM-01, FR-COM-05),
 * in any environment: `pnpm db:product-file` runs it with that environment's
 * database and storage credentials.
 *
 * A product with a file keeps its asset row, so the download links buyers
 * already received deliver the new file. Objects are named by their hash, so
 * the upload never overwrites the file a link may be serving right now; the
 * previous object is deleted only after the row points to the new one and the
 * download URLs signed for it have expired. A run whose row is current but
 * whose object is missing from storage uploads it again.
 */

/**
 * How long the previous file stays after a replacement: download URLs are signed
 * for 60 seconds (SIGNED_URL_SECONDS in apps/api/src/modules/downloads.ts), so a
 * buyer whose link was exchanged just before the swap still gets the file.
 */
export const PREVIOUS_FILE_GRACE_MS = 65_000;

/** Private product-files bucket (STORAGE_BUCKET). */
export interface ProductFileStorage {
	upload(path: string, bytes: Uint8Array, contentType: string): Promise<void>;
	exists(path: string): Promise<boolean>;
	remove(paths: string[]): Promise<void>;
}

export interface ProductFileOptions {
	/** Waits before the previous file is deleted; tests pass one that does not sleep. */
	sleep?: (ms: number) => Promise<void>;
}

export class ProductFileRefusedError extends Error {}

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

// The product-files bucket accepts only these two types.
const kinds = [
	{ extension: 'pdf', contentType: 'application/pdf', label: 'a PDF', magic: [0x25, 0x50, 0x44, 0x46, 0x2d] },
	{ extension: 'zip', contentType: 'application/zip', label: 'a ZIP', magic: [0x50, 0x4b, 0x03, 0x04] }
] as const;

// Plain ASCII, so the name survives Content-Disposition and every mail client unchanged.
const safeFilename = /^[A-Za-z0-9][A-Za-z0-9._-]{0,150}$/;

export async function replaceProductFile(
	handle: DatabaseHandle,
	storage: ProductFileStorage,
	input: ProductFileInput,
	options: ProductFileOptions = {}
): Promise<ProductFileResult> {
	const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const kind = kinds.find((entry) => entry.magic.every((byte, index) => input.bytes[index] === byte));
	if (!kind) throw new ProductFileRefusedError(`${input.filename} is not a PDF or ZIP file`);
	if (!input.filename.toLowerCase().endsWith(`.${kind.extension}`)) {
		throw new ProductFileRefusedError(`${input.filename} is ${kind.label}; name it with the .${kind.extension} extension`);
	}
	if (!safeFilename.test(input.filename)) {
		throw new ProductFileRefusedError(`Download name ${input.filename} may only use letters A-Z, digits, dots, dashes and underscores`);
	}

	// Resolving a slug to its organization is the one cross-tenant step.
	const [organization] = await handle.withPlatform((db) =>
		db.select({ id: s.organizations.id }).from(s.organizations).where(eq(s.organizations.slug, input.organizationSlug))
	);
	if (!organization) throw new ProductFileRefusedError(`Unknown organization ${input.organizationSlug}`);
	const organizationId = organization.id;

	const sha256 = createHash('sha256').update(input.bytes).digest('hex');
	const sizeBytes = input.bytes.byteLength;
	const target = (productId: string) => `${organizationId}/${productId}/${sha256.slice(0, 16)}.${kind.extension}`;

	const current = await handle.withTenant(organizationId, (tx) => productWithFile(tx, input));
	const storagePath = target(current.product.id);
	const base = { organizationId, productId: current.product.id, storagePath, sizeBytes };
	if (current.asset?.storagePath === storagePath && current.asset.filename === input.filename) {
		if (await storage.exists(storagePath)) return { ...base, outcome: 'unchanged', assetId: current.asset.id };
		// The row is right but the object is gone: put the same bytes back under the same name.
		await storage.upload(storagePath, input.bytes, kind.contentType);
		await handle.withTenant(organizationId, (tx) =>
			tx.insert(s.auditEvents).values({
				organizationId,
				actorType: 'system',
				action: 'product.file_restored',
				targetType: 'product',
				targetId: current.product.id,
				metadata: { filename: input.filename, sizeBytes, sha256 }
			})
		);
		return { ...base, outcome: 'restored', assetId: current.asset.id };
	}

	await storage.upload(storagePath, input.bytes, kind.contentType);
	let written: { outcome: 'added' | 'replaced'; assetId: string; previous: string | null };
	try {
		written = await handle.withTenant(organizationId, async (tx) => {
			// Read again under the product's row lock, which serializes concurrent runs: the state may
			// have changed during the upload.
			const { product, asset } = await productWithFile(tx, input, true);
			const metadata = { filename: input.filename, sizeBytes, sha256 };
			const file = { storagePath, filename: input.filename, contentType: kind.contentType, sizeBytes };
			if (asset) {
				await tx.update(s.productAssets).set(file).where(eq(s.productAssets.id, asset.id));
				await tx.insert(s.auditEvents).values({
					organizationId,
					actorType: 'system',
					action: 'product.file_replaced',
					targetType: 'product',
					targetId: product.id,
					metadata: { ...metadata, previous: { filename: asset.filename, sizeBytes: asset.sizeBytes } }
				});
				return { outcome: 'replaced', assetId: asset.id, previous: asset.storagePath === storagePath ? null : asset.storagePath };
			}
			const [row] = await tx.insert(s.productAssets).values({ organizationId, productId: product.id, ...file }).returning({ id: s.productAssets.id });
			await tx.insert(s.auditEvents).values({ organizationId, actorType: 'system', action: 'product.file_added', targetType: 'product', targetId: product.id, metadata });
			return { outcome: 'added', assetId: row!.id, previous: null };
		});
	} catch (error) {
		// Remove the new object only if no row points to it. The read before the upload is not
		// enough: another run may have put the same file in place meanwhile, or the write may have
		// committed before the error. If even this read fails, keep the object (an orphan file is
		// harmless, a row pointing to nothing is not).
		const referenced = await handle
			.withTenant(organizationId, (tx) => tx.select({ id: s.productAssets.id }).from(s.productAssets).where(eq(s.productAssets.storagePath, storagePath)))
			.then((rows) => rows.length > 0)
			.catch(() => true);
		if (!referenced) await storage.remove([storagePath]).catch(() => undefined);
		throw error;
	}

	const result: ProductFileResult = { ...base, outcome: written.outcome, assetId: written.assetId };
	if (written.previous) {
		await sleep(PREVIOUS_FILE_GRACE_MS);
		try {
			await storage.remove([written.previous]);
		} catch (error) {
			result.staleFile = { path: written.previous, error: error instanceof Error ? error.message : String(error) };
		}
	}
	return result;
}

async function productWithFile(tx: Tx, input: ProductFileInput, lock = false) {
	const products = tx.select({ id: s.products.id, kind: s.products.kind }).from(s.products).where(eq(s.products.slug, input.productSlug));
	const [product] = lock ? await products.for('update') : await products;
	if (!product) throw new ProductFileRefusedError(`Organization ${input.organizationSlug} has no product ${input.productSlug}`);
	if (product.kind !== 'digital') throw new ProductFileRefusedError(`${input.productSlug} is a physical product; only digital products deliver files`);
	const assets = await tx.select().from(s.productAssets).where(eq(s.productAssets.productId, product.id));
	if (assets.length > 1) throw new ProductFileRefusedError(`${input.productSlug} has ${assets.length} files; this command replaces exactly one`);
	return { product, asset: assets[0] ?? null };
}
