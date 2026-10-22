import { createHash, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createDatabase, schema as s, type DatabaseHandle } from '../src';
import { ProductFileRefusedError, replaceProductFile, type ProductFileStorage } from '../src/product-file';

let handle: DatabaseHandle;
let client: postgres.Sql;

const settings = {
	contact: {},
	social: {},
	delivery: { pickupEnabled: false, shippingEnabled: false, shippingFeeMinor: 0 },
	legal: { termsVersion: 't', privacyVersion: 'p' }
};

const orgId = randomUUID();
const orgSlug = `files-${orgId.slice(0, 8)}`;
const ids = { manual: randomUUID(), checklist: randomUUID(), sticker: randomUUID(), bundle: randomUUID() };
// Download grants point to this id, so keeping it is what makes links already sent deliver the new file.
const manualAsset = randomUUID();
const oldManualPath = `${orgId}/${ids.manual}/manual-tecnico.pdf`;

const pdf = (text: string) => new TextEncoder().encode(`%PDF-1.4\n% ${text}\n%%EOF\n`);
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** In-memory bucket that records every call, so the tests need no storage service. */
function fakeStorage(initial: Record<string, Uint8Array> = {}, options: { failRemove?: boolean } = {}) {
	const objects = new Map(Object.entries(initial));
	const calls: string[] = [];
	const storage: ProductFileStorage = {
		async upload(path, bytes, contentType) {
			calls.push(`upload ${path} ${contentType}`);
			objects.set(path, bytes);
		},
		async remove(paths) {
			calls.push(`remove ${paths.join(',')}`);
			if (options.failRemove) throw new Error('storage is down');
			for (const path of paths) objects.delete(path);
		}
	};
	return { storage, objects, calls };
}

async function assetsOf(productId: string) {
	return client<{ id: string; storage_path: string; filename: string; content_type: string; size_bytes: number }[]>`
		select id, storage_path, filename, content_type, size_bytes from app.product_assets where product_id = ${productId} order by created_at`;
}

async function audits(productId: string) {
	return client<{ actor_type: string; action: string; metadata: Record<string, unknown> }[]>`
		select actor_type, action, metadata from app.audit_events where target_id = ${productId} order by created_at`;
}

async function refusal(promise: Promise<unknown>): Promise<string> {
	const error = await promise.then(
		() => null,
		(caught: unknown) => caught
	);
	expect(error).toBeInstanceOf(ProductFileRefusedError);
	return (error as Error).message;
}

beforeAll(async () => {
	handle = createDatabase(inject('databaseUrl'), { max: 2 });
	client = postgres(inject('databaseUrl'), { max: 1, onnotice: () => {} });
	await handle.withPlatform(async (db) => {
		await db.insert(s.organizations).values({ id: orgId, slug: orgSlug, name: 'Files', orderPrefix: 'FL', settings });
		await db.insert(s.products).values([
			{ id: ids.manual, organizationId: orgId, slug: 'manual-tecnico', name: 'Manual', description: 'd', kind: 'digital', status: 'active' },
			{ id: ids.checklist, organizationId: orgId, slug: 'checklist-digital', name: 'Checklist', description: 'd', kind: 'digital', status: 'active' },
			{ id: ids.sticker, organizationId: orgId, slug: 'calcomania', name: 'Calcomanía', description: 'd', kind: 'physical', status: 'active' },
			{ id: ids.bundle, organizationId: orgId, slug: 'bundle', name: 'Bundle', description: 'd', kind: 'digital', status: 'active' }
		]);
		await db.insert(s.productAssets).values([
			{ id: manualAsset, organizationId: orgId, productId: ids.manual, storagePath: oldManualPath, filename: 'manual-tecnico.pdf', contentType: 'application/pdf', sizeBytes: 10 },
			{ organizationId: orgId, productId: ids.bundle, storagePath: `${orgId}/${ids.bundle}/a.pdf`, filename: 'a.pdf', contentType: 'application/pdf', sizeBytes: 1 },
			{ organizationId: orgId, productId: ids.bundle, storagePath: `${orgId}/${ids.bundle}/b.pdf`, filename: 'b.pdf', contentType: 'application/pdf', sizeBytes: 1 }
		]);
	});
});

afterAll(async () => {
	await client.end();
	await handle.close();
});

describe('replaceProductFile', () => {
	it('adds the file to a digital product that has none, and records it in the audit log', async () => {
		const bytes = pdf('checklist');
		const { storage, objects, calls } = fakeStorage();

		const result = await replaceProductFile(handle, storage, { organizationSlug: orgSlug, productSlug: 'checklist-digital', filename: 'MotoGarage-Checklist-de-Viaje.pdf', bytes });

		expect(result).toMatchObject({ outcome: 'added', organizationId: orgId, productId: ids.checklist, sizeBytes: bytes.byteLength });
		expect(result.staleFile).toBeUndefined();
		expect(result.storagePath).toBe(`${orgId}/${ids.checklist}/${sha(bytes).slice(0, 16)}.pdf`);
		expect(calls).toEqual([`upload ${result.storagePath} application/pdf`]);
		expect(objects.get(result.storagePath)).toEqual(bytes);
		expect(await assetsOf(ids.checklist)).toEqual([
			{ id: result.assetId, storage_path: result.storagePath, filename: 'MotoGarage-Checklist-de-Viaje.pdf', content_type: 'application/pdf', size_bytes: bytes.byteLength }
		]);
		expect(await audits(ids.checklist)).toEqual([
			{
				actor_type: 'system',
				action: 'product.file_added',
				metadata: { filename: 'MotoGarage-Checklist-de-Viaje.pdf', sizeBytes: bytes.byteLength, sha256: sha(bytes) }
			}
		]);
	});

	it('replaces the file in place, so links already sent deliver the new file, and deletes the old one', async () => {
		const bytes = pdf('real manual');
		const { storage, objects, calls } = fakeStorage({ [oldManualPath]: pdf('sample') });

		const result = await replaceProductFile(handle, storage, { organizationSlug: orgSlug, productSlug: 'manual-tecnico', filename: 'Guia-visual-ilustrada-Mecanica-de-Motos.pdf', bytes });

		expect(result).toMatchObject({ outcome: 'replaced', assetId: manualAsset, productId: ids.manual });
		expect(calls).toEqual([`upload ${result.storagePath} application/pdf`, `remove ${oldManualPath}`]);
		expect([...objects.keys()]).toEqual([result.storagePath]);
		expect(await assetsOf(ids.manual)).toEqual([
			{ id: manualAsset, storage_path: result.storagePath, filename: 'Guia-visual-ilustrada-Mecanica-de-Motos.pdf', content_type: 'application/pdf', size_bytes: bytes.byteLength }
		]);
		expect(await audits(ids.manual)).toEqual([
			{
				actor_type: 'system',
				action: 'product.file_replaced',
				metadata: {
					filename: 'Guia-visual-ilustrada-Mecanica-de-Motos.pdf',
					sizeBytes: bytes.byteLength,
					sha256: sha(bytes),
					previous: { filename: 'manual-tecnico.pdf', sizeBytes: 10 }
				}
			}
		]);
	});

	it('does nothing when the product already has exactly this file', async () => {
		const bytes = pdf('real manual');
		const before = await assetsOf(ids.manual);
		const auditsBefore = await audits(ids.manual);
		const { storage, calls } = fakeStorage();

		const result = await replaceProductFile(handle, storage, { organizationSlug: orgSlug, productSlug: 'manual-tecnico', filename: 'Guia-visual-ilustrada-Mecanica-de-Motos.pdf', bytes });

		expect(result).toMatchObject({ outcome: 'unchanged', assetId: manualAsset, storagePath: before[0]!.storage_path });
		expect(calls).toEqual([]);
		expect(await assetsOf(ids.manual)).toEqual(before);
		expect(await audits(ids.manual)).toEqual(auditsBefore);
	});

	it('keeps the new file and reports the old one when it cannot be deleted', async () => {
		const bytes = pdf('real manual v2');
		const previous = (await assetsOf(ids.manual))[0]!.storage_path;
		const { storage } = fakeStorage({ [previous]: pdf('real manual') }, { failRemove: true });

		const result = await replaceProductFile(handle, storage, { organizationSlug: orgSlug, productSlug: 'manual-tecnico', filename: 'Guia-visual-ilustrada-Mecanica-de-Motos.pdf', bytes });

		expect(result.outcome).toBe('replaced');
		expect(result.staleFile).toEqual({ path: previous, error: 'storage is down' });
		expect((await assetsOf(ids.manual))[0]).toMatchObject({ id: manualAsset, storage_path: result.storagePath, size_bytes: bytes.byteLength });
	});

	it('gives a product one file even when two first uploads run at the same time', async () => {
		const id = randomUUID();
		await handle.withPlatform((db) => db.insert(s.products).values({ id, organizationId: orgId, slug: 'race', name: 'Race', description: 'd', kind: 'digital', status: 'active' }));
		const { storage, objects } = fakeStorage();

		const results = await Promise.all(['a', 'b'].map((name) => replaceProductFile(handle, storage, { organizationSlug: orgSlug, productSlug: 'race', filename: `${name}.pdf`, bytes: pdf(name) })));

		const assets = await assetsOf(id);
		expect(assets).toHaveLength(1);
		expect(results.map((result) => result.outcome).sort()).toEqual(['added', 'replaced']);
		expect([...objects.keys()].filter((path) => path.includes(id))).toEqual([assets[0]!.storage_path]);
	});

	describe('refuses, leaving rows and storage untouched', () => {
		const cases: { name: string; productSlug: string; filename: string; bytes: Uint8Array; organizationSlug?: string; message: string }[] = [
			{ name: 'an unknown organization', organizationSlug: 'nope-org', productSlug: 'manual-tecnico', filename: 'm.pdf', bytes: pdf('x'), message: 'Unknown organization nope-org' },
			{ name: 'an unknown product', productSlug: 'nope', filename: 'm.pdf', bytes: pdf('x'), message: `Organization ${orgSlug} has no product nope` },
			{ name: 'a physical product', productSlug: 'calcomania', filename: 'm.pdf', bytes: pdf('x'), message: 'calcomania is a physical product; only digital products deliver files' },
			{ name: 'a product with several files', productSlug: 'bundle', filename: 'm.pdf', bytes: pdf('x'), message: 'bundle has 2 files; this command replaces exactly one' },
			{ name: 'a file that is not a PDF or ZIP', productSlug: 'checklist-digital', filename: 'm.pdf', bytes: new TextEncoder().encode('<html>'), message: 'm.pdf is not a PDF or ZIP file' },
			{ name: 'an extension that does not match the content', productSlug: 'checklist-digital', filename: 'm.zip', bytes: pdf('x'), message: 'm.zip is a PDF; name it with the .pdf extension' },
			{ name: 'a download name with unsafe characters', productSlug: 'checklist-digital', filename: 'Guía de motos.pdf', bytes: pdf('x'), message: 'Download name Guía de motos.pdf may only use letters A-Z, digits, dots, dashes and underscores' }
		];

		for (const entry of cases) {
			it(entry.name, async () => {
				const products = [ids.manual, ids.checklist, ids.sticker, ids.bundle];
				const before = await Promise.all(products.map(assetsOf));
				const auditsBefore = await Promise.all(products.map(audits));
				const { storage, calls } = fakeStorage();

				const message = await refusal(
					replaceProductFile(handle, storage, { organizationSlug: entry.organizationSlug ?? orgSlug, productSlug: entry.productSlug, filename: entry.filename, bytes: entry.bytes })
				);

				expect(message).toBe(entry.message);
				expect(calls).toEqual([]);
				expect(await Promise.all(products.map(assetsOf))).toEqual(before);
				expect(await Promise.all(products.map(audits))).toEqual(auditsBefore);
			});
		}
	});
});
