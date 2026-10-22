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
 * previous object is deleted only after the row points to the new one.
 */

/** Private product-files bucket (STORAGE_BUCKET). */
export interface ProductFileStorage {
	upload(path: string, bytes: Uint8Array, contentType: string): Promise<void>;
	remove(paths: string[]): Promise<void>;
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
	outcome: 'added' | 'replaced' | 'unchanged';
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

export async function replaceProductFile(handle: DatabaseHandle, storage: ProductFileStorage, input: ProductFileInput): Promise<ProductFileResult> {
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
		return { ...base, outcome: 'unchanged', assetId: current.asset.id };
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
		// Nothing points to the new object unless it was already the current file.
		if (current.asset?.storagePath !== storagePath) await storage.remove([storagePath]).catch(() => undefined);
		throw error;
	}

	const result: ProductFileResult = { ...base, outcome: written.outcome, assetId: written.assetId };
	if (written.previous) {
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
