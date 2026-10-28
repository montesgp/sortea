import { createHash, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createDatabase, schema as s, type DatabaseHandle } from '../src';
import { PREVIOUS_FILE_GRACE_MS, ProductFileRefusedError, replaceProductFile as replace, type ProductFileInput, type ProductFileStorage } from '../src/product-file';

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

// The calls of the storage in use, so the grace wait is recorded in order with them.
let currentCalls: string[] = [];

/** Never sleeps: the grace wait before deleting the previous file is recorded instead. */
function replaceProductFile(database: typeof handle, storage: ProductFileStorage, input: ProductFileInput) {
	return replace(database, storage, input, { sleep: async (ms) => void currentCalls.push(`wait ${ms}`) });
}

/** In-memory bucket that records every call, so the tests need no storage service. */
function fakeStorage(initial: Record<string, Uint8Array> = {}, options: { failRemove?: boolean; onUpload?: () => Promise<void> } = {}) {
	const objects = new Map(Object.entries(initial));
	const calls: string[] = [];
	currentCalls = calls;
	const storage: ProductFileStorage = {
		async upload(path, bytes, contentType) {
			calls.push(`upload ${path} ${contentType}`);
			objects.set(path, bytes);
			await options.onUpload?.();
		},
		async exists(path) {
			return objects.has(path);
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
		// Links signed just before the swap keep working: the old file goes once they expire.
		expect(calls).toEqual([`upload ${result.storagePath} application/pdf`, `wait ${PREVIOUS_FILE_GRACE_MS}`, `remove ${oldManualPath}`]);
		expect(PREVIOUS_FILE_GRACE_MS).toBeGreaterThan(60_000);
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
		const { storage, calls } = fakeStorage({ [before[0]!.storage_path]: bytes });

		const result = await replaceProductFile(handle, storage, { organizationSlug: orgSlug, productSlug: 'manual-tecnico', filename: 'Guia-visual-ilustrada-Mecanica-de-Motos.pdf', bytes });

		expect(result).toMatchObject({ outcome: 'unchanged', assetId: manualAsset, storagePath: before[0]!.storage_path });
		expect(calls).toEqual([]);
		expect(await assetsOf(ids.manual)).toEqual(before);
		expect(await audits(ids.manual)).toEqual(auditsBefore);
	});

	it('keeps the previous file when another run makes it current again during the wait', async () => {
		const [row] = await assetsOf(ids.manual);
		const current = row!.storage_path;
		const bytes = pdf('manual v3');
		const { storage, objects, calls } = fakeStorage({ [current]: pdf('real manual') });
		const swapBack = async () => {
			// During the grace wait an operator switches the product back to the file it had.
			await client`update app.product_assets set storage_path = ${current} where id = ${manualAsset}`;
		};

		const result = await replace(handle, storage, { organizationSlug: orgSlug, productSlug: 'manual-tecnico', filename: 'Guia-visual-ilustrada-Mecanica-de-Motos.pdf', bytes }, { sleep: swapBack });

		expect(result.outcome).toBe('replaced');
		expect(calls).toEqual([`upload ${result.storagePath} application/pdf`]);
		expect(objects.has(current)).toBe(true);
		// The product is left on `current`, as the swap back put it, for the next tests.
	});

	it('uploads the file again when the product points to it but storage lost it', async () => {
		const bytes = pdf('real manual');
		const [row] = await assetsOf(ids.manual);
		const auditsBefore = await audits(ids.manual);
		const { storage, objects, calls } = fakeStorage();

		const result = await replaceProductFile(handle, storage, { organizationSlug: orgSlug, productSlug: 'manual-tecnico', filename: 'Guia-visual-ilustrada-Mecanica-de-Motos.pdf', bytes });

		expect(result).toMatchObject({ outcome: 'restored', assetId: manualAsset, storagePath: row!.storage_path });
		expect(calls).toEqual([`upload ${row!.storage_path} application/pdf`]);
		expect(objects.get(row!.storage_path)).toEqual(bytes);
		expect(await assetsOf(ids.manual)).toEqual([row]);
		expect((await audits(ids.manual)).slice(auditsBefore.length)).toEqual([
			{ actor_type: 'system', action: 'product.file_restored', metadata: { filename: 'Guia-visual-ilustrada-Mecanica-de-Motos.pdf', sizeBytes: bytes.byteLength, sha256: sha(bytes) } }
		]);
	});

	it('keeps the new object when the write fails but the product already points to it', async () => {
		const bytes = pdf('checklist v2');
		const { storage, objects } = fakeStorage(
			{},
			{
				// While this run uploads, another run puts the same file in place; then this run's write fails.
				onUpload: async () => {
					if (objects.size > 1) return;
					const other = fakeStorage();
					await replaceProductFile(handle, other.storage, { organizationSlug: orgSlug, productSlug: 'checklist-digital', filename: 'MotoGarage-Checklist-de-Viaje.pdf', bytes });
					currentCalls = [];
					await client`update app.products set kind = 'physical' where id = ${ids.checklist}`;
				}
			}
		);
		try {
			const message = await refusal(replaceProductFile(handle, storage, { organizationSlug: orgSlug, productSlug: 'checklist-digital', filename: 'MotoGarage-Checklist-de-Viaje.pdf', bytes }));
			expect(message).toBe('checklist-digital is a physical product; only digital products deliver files');
			const [row] = await assetsOf(ids.checklist);
			expect(row!.storage_path).toBe(`${orgId}/${ids.checklist}/${sha(bytes).slice(0, 16)}.pdf`);
			expect(objects.has(row!.storage_path)).toBe(true);
		} finally {
			await client`update app.products set kind = 'digital' where id = ${ids.checklist}`;
		}
	});

	it('removes the uploaded object when the write fails and nothing points to it', async () => {
		const bytes = pdf('never stored');
		const before = await assetsOf(ids.checklist);
		const { storage, objects, calls } = fakeStorage({}, { onUpload: async () => void (await client`update app.products set kind = 'physical' where id = ${ids.checklist}`) });
		try {
			await refusal(replaceProductFile(handle, storage, { organizationSlug: orgSlug, productSlug: 'checklist-digital', filename: 'otro.pdf', bytes }));
			expect(calls.at(-1)).toMatch(/^remove /);
			expect(objects.size).toBe(0);
			expect(await assetsOf(ids.checklist)).toEqual(before);
		} finally {
			await client`update app.products set kind = 'digital' where id = ${ids.checklist}`;
		}
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
