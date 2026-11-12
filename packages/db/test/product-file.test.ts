import { createHash, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createDatabase, schema as s, type DatabaseHandle } from '../src';
import {
	addProductFile,
	PREVIOUS_FILE_GRACE_MS,
	ProductFileRefusedError,
	removeProductFileAsset,
	removeUnreferencedFile,
	replaceProductFile as replace,
	replaceProductFileAsset,
	syncProductFiles as sync,
	type ProductFileInput,
	type ProductFileStorage,
	type ProductFilesInput
} from '../src/product-file';

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
const png = (text: string) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new TextEncoder().encode(text)]);
const jpeg = (text: string) => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new TextEncoder().encode(text)]);
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

// The calls of the storage in use, so the grace wait is recorded in order with them.
let currentCalls: string[] = [];

/** Never sleeps: the grace wait before deleting the previous file is recorded instead. */
function replaceProductFile(database: typeof handle, storage: ProductFileStorage, input: ProductFileInput) {
	return replace(database, storage, input, { sleep: async (ms) => void currentCalls.push(`wait ${ms}`) });
}

/** The list command of a client pack, never sleeping either. */
function syncProductFiles(database: typeof handle, storage: ProductFileStorage, input: ProductFilesInput) {
	return sync(database, storage, input, { sleep: async (ms) => void currentCalls.push(`wait ${ms}`) });
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

		const result = await replaceProductFile(handle, storage, { organizationSlug: orgSlug, productSlug: 'checklist-digital', filename: 'Checklist-de-Viaje.pdf', bytes });

		expect(result).toMatchObject({ outcome: 'added', organizationId: orgId, productId: ids.checklist, sizeBytes: bytes.byteLength });
		expect(result.staleFile).toBeUndefined();
		expect(result.storagePath).toBe(`${orgId}/${ids.checklist}/${sha(bytes).slice(0, 16)}.pdf`);
		expect(calls).toEqual([`upload ${result.storagePath} application/pdf`]);
		expect(objects.get(result.storagePath)).toEqual(bytes);
		expect(await assetsOf(ids.checklist)).toEqual([
			{ id: result.assetId, storage_path: result.storagePath, filename: 'Checklist-de-Viaje.pdf', content_type: 'application/pdf', size_bytes: bytes.byteLength }
		]);
		expect(await audits(ids.checklist)).toEqual([
			{
				actor_type: 'system',
				action: 'product.file_added',
				metadata: { filename: 'Checklist-de-Viaje.pdf', sizeBytes: bytes.byteLength, sha256: sha(bytes) }
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
					await replaceProductFile(handle, other.storage, { organizationSlug: orgSlug, productSlug: 'checklist-digital', filename: 'Checklist-de-Viaje.pdf', bytes });
					currentCalls = [];
					await client`update app.products set kind = 'physical' where id = ${ids.checklist}`;
				}
			}
		);
		try {
			const message = await refusal(replaceProductFile(handle, storage, { organizationSlug: orgSlug, productSlug: 'checklist-digital', filename: 'Checklist-de-Viaje.pdf', bytes }));
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
			{
				name: 'a product with several files',
				productSlug: 'bundle',
				filename: 'm.pdf',
				bytes: pdf('x'),
				message: `bundle has 2 files; this command replaces exactly one. Add or remove each of its files in the back office (Productos, "Archivos para descargar"), or list them under files.bundle of the client pack and run pnpm client:load ${orgSlug} --update --catalog`
			},
			{ name: 'a file that is not a PDF, ZIP, PNG or JPEG', productSlug: 'checklist-digital', filename: 'm.pdf', bytes: new TextEncoder().encode('<html>'), message: 'm.pdf is not a PDF, ZIP, PNG or JPEG file' },
			{ name: 'an image named as another kind', productSlug: 'checklist-digital', filename: 'm.jpg', bytes: png('x'), message: 'm.jpg is a PNG image; name it with the .png extension' },
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

// Owner feedback 2026-11-11b, S2: a digital product may deliver several files, each with its own
// download link, in order. The back office adds, replaces and removes them one at a time.
describe('a product with several files', () => {
	const admin = { actorType: 'admin' as const, actorId: randomUUID() };

	async function digital(slug: string) {
		const id = randomUUID();
		await handle.withPlatform((db) => db.insert(s.products).values({ id, organizationId: orgId, slug, name: slug, description: 'd', kind: 'digital', status: 'active' }));
		return id;
	}

	async function filesOf(productId: string) {
		return client<{ id: string; storage_path: string; filename: string; content_type: string; position: number }[]>`
			select id, storage_path, filename, content_type, position from app.product_assets where product_id = ${productId} order by position, created_at`;
	}

	/** A paid order holding a download link to the file, as the paid email leaves it. */
	async function grantFor(assetId: string) {
		const contactId = randomUUID();
		const orderId = randomUUID();
		await handle.withPlatform(async (db) => {
			await db.insert(s.contacts).values({ id: contactId, organizationId: orgId, firstName: 'Ana', lastName: 'A', email: `${contactId}@example.com` });
			await db.insert(s.orders).values({
				id: orderId,
				organizationId: orgId,
				reference: `FL-${orderId.slice(0, 6)}`,
				accessCodeHash: 'x',
				contactId,
				buyer: { firstName: 'Ana', lastName: 'A', email: 'ana@example.com', phone: null },
				status: 'paid',
				currency: 'ARS',
				subtotalMinor: 100,
				deliveryFeeMinor: 0,
				totalMinor: 100,
				deliveryMethod: 'digital',
				pricingSnapshot: { lines: [], subtotalMinor: 100, deliveryFeeMinor: 0, totalMinor: 100, currency: 'ARS', pricedAt: '' },
				paymentProvider: 'mercadopago',
				expiresAt: new Date()
			});
			await db.insert(s.downloadGrants).values({ organizationId: orgId, orderId, productAssetId: assetId, tokenHash: `t-${randomUUID()}`, expiresAt: new Date(Date.now() + 3_600_000) });
		});
		return orderId;
	}

	it('adds PNG and JPEG files after the ones the product has, each recorded in the audit log', async () => {
		const productId = await digital('calcomania-multi');
		const { storage, objects, calls } = fakeStorage();
		const first = png('con borde');
		const second = jpeg('fondo');

		const a = await addProductFile(handle, storage, { organizationId: orgId, productId, filename: 'Calcomania-con-borde.png', bytes: first, actor: admin });
		const b = await addProductFile(handle, storage, { organizationId: orgId, productId, filename: 'Fondo-celular.jpeg', bytes: second, actor: admin });

		expect(a).toMatchObject({ outcome: 'added', position: 0, storagePath: `${orgId}/${productId}/${sha(first).slice(0, 16)}.png`, sizeBytes: first.byteLength });
		expect(b).toMatchObject({ outcome: 'added', position: 1, storagePath: `${orgId}/${productId}/${sha(second).slice(0, 16)}.jpg` });
		expect(calls).toEqual([`upload ${a.storagePath} image/png`, `upload ${b.storagePath} image/jpeg`]);
		expect(objects.get(b.storagePath)).toEqual(second);
		expect(await filesOf(productId)).toEqual([
			{ id: a.assetId, storage_path: a.storagePath, filename: 'Calcomania-con-borde.png', content_type: 'image/png', position: 0 },
			{ id: b.assetId, storage_path: b.storagePath, filename: 'Fondo-celular.jpeg', content_type: 'image/jpeg', position: 1 }
		]);
		const rows = await client<{ actor_type: string; actor_id: string; action: string; metadata: Record<string, unknown> }[]>`
			select actor_type, actor_id, action, metadata from app.audit_events where target_id = ${productId} order by created_at`;
		expect(rows).toEqual([
			{ actor_type: 'admin', actor_id: admin.actorId, action: 'product.file_added', metadata: { filename: 'Calcomania-con-borde.png', sizeBytes: first.byteLength, sha256: sha(first) } },
			{ actor_type: 'admin', actor_id: admin.actorId, action: 'product.file_added', metadata: { filename: 'Fondo-celular.jpeg', sizeBytes: second.byteLength, sha256: sha(second) } }
		]);
	});

	it('refuses the same file twice and an eleventh file, uploading nothing', async () => {
		const productId = await digital('calcomania-full');
		const { storage, calls } = fakeStorage();
		for (let index = 0; index < 10; index++) await addProductFile(handle, storage, { organizationId: orgId, productId, filename: `f${index}.png`, bytes: png(`f${index}`), actor: admin });
		calls.length = 0;

		const again = await refusal(addProductFile(handle, storage, { organizationId: orgId, productId, filename: 'otra.png', bytes: png('f3'), actor: admin }));
		expect(again).toBe('calcomania-full already has this file, as f3.png');
		const full = await refusal(addProductFile(handle, storage, { organizationId: orgId, productId, filename: 'f10.png', bytes: png('f10'), actor: admin }));
		expect(full).toBe('calcomania-full already has 10 files, the most a product delivers');
		expect(calls).toEqual([]);
		expect(await filesOf(productId)).toHaveLength(10);
	});

	it('replaces one file in place, so its links already sent deliver the new one, and leaves the others alone', async () => {
		const productId = await digital('calcomania-swap');
		const { storage, objects, calls } = fakeStorage();
		const a = await addProductFile(handle, storage, { organizationId: orgId, productId, filename: 'a.png', bytes: png('a'), actor: admin });
		const b = await addProductFile(handle, storage, { organizationId: orgId, productId, filename: 'b.png', bytes: png('b'), actor: admin });
		calls.length = 0;

		const replaced = await replaceProductFileAsset(handle, storage, { organizationId: orgId, productId, assetId: a.assetId, filename: 'a2.jpg', bytes: jpeg('a2'), actor: admin });

		expect(replaced).toMatchObject({ outcome: 'replaced', assetId: a.assetId, previous: a.storagePath });
		expect(calls).toEqual([`upload ${replaced.storagePath} image/jpeg`]);
		expect(objects.has(a.storagePath)).toBe(true);
		expect(await filesOf(productId)).toEqual([
			{ id: a.assetId, storage_path: replaced.storagePath, filename: 'a2.jpg', content_type: 'image/jpeg', position: 0 },
			{ id: b.assetId, storage_path: b.storagePath, filename: 'b.png', content_type: 'image/png', position: 1 }
		]);
		const [audit] = await client<{ action: string; metadata: Record<string, unknown> }[]>`
			select action, metadata from app.audit_events where target_id = ${productId} and action = 'product.file_replaced'`;
		expect(audit!.metadata).toEqual({ filename: 'a2.jpg', sizeBytes: jpeg('a2').byteLength, sha256: sha(jpeg('a2')), previous: { filename: 'a.png', sizeBytes: png('a').byteLength } });

		// The previous object goes once its signed URLs expired, unless a row points to it again.
		expect(await removeUnreferencedFile(handle, storage, orgId, a.storagePath, { sleep: async (ms) => void calls.push(`wait ${ms}`) })).toBeUndefined();
		expect(calls.slice(1)).toEqual([`wait ${PREVIOUS_FILE_GRACE_MS}`, `remove ${a.storagePath}`]);
		await removeUnreferencedFile(handle, storage, orgId, b.storagePath, { sleep: async () => undefined });
		expect(objects.has(b.storagePath)).toBe(true);
	});

	it('removes one file with its download links, and records how many links stopped working', async () => {
		const productId = await digital('calcomania-remove');
		const { storage } = fakeStorage();
		const a = await addProductFile(handle, storage, { organizationId: orgId, productId, filename: 'a.png', bytes: png('ra'), actor: admin });
		const b = await addProductFile(handle, storage, { organizationId: orgId, productId, filename: 'b.png', bytes: png('rb'), actor: admin });
		const orderId = await grantFor(a.assetId);
		await grantFor(b.assetId);

		const removed = await removeProductFileAsset(handle, { organizationId: orgId, productId, assetId: a.assetId, actor: admin });

		expect(removed).toEqual({ assetId: a.assetId, filename: 'a.png', storagePath: a.storagePath, grants: 1 });
		expect((await filesOf(productId)).map((file) => file.id)).toEqual([b.assetId]);
		expect(await client`select product_asset_id from app.download_grants where order_id = ${orderId}`).toEqual([]);
		expect(await client`select count(*)::int as n from app.download_grants where product_asset_id = ${b.assetId}`).toEqual([{ n: 1 }]);
		const [audit] = await client<{ actor_type: string; metadata: Record<string, unknown> }[]>`
			select actor_type, metadata from app.audit_events where target_id = ${productId} and action = 'product.file_removed'`;
		expect(audit).toEqual({ actor_type: 'admin', metadata: { filename: 'a.png', sizeBytes: png('ra').byteLength, grants: 1 } });

		expect(await refusal(removeProductFileAsset(handle, { organizationId: orgId, productId, assetId: a.assetId, actor: admin }))).toBe('calcomania-remove has no such file');
	});

	it('syncs a list: keeps matching files, reuses a replaced row so sent links work, adds and removes the rest', async () => {
		const productId = await digital('calcomania-sync');
		const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]);
		const { storage, objects, calls } = fakeStorage();
		const old = await addProductFile(handle, storage, { organizationId: orgId, productId, filename: 'Calcomania.zip', bytes: zip, actor: admin });
		const grantOrder = await grantFor(old.assetId);
		calls.length = 0;
		const files = [
			{ filename: 'TallerDemo-calcomania-con-borde.png', bytes: png('s1') },
			{ filename: 'TallerDemo-calcomania.png', bytes: png('s2') },
			{ filename: 'TallerDemo-fondo-celular.png', bytes: png('s3') }
		];

		const result = await syncProductFiles(handle, storage, { organizationSlug: orgSlug, productSlug: 'calcomania-sync', files });

		expect(result.changes).toEqual([
			{ filename: 'TallerDemo-calcomania-con-borde.png', outcome: 'replaced' },
			{ filename: 'TallerDemo-calcomania.png', outcome: 'added' },
			{ filename: 'TallerDemo-fondo-celular.png', outcome: 'added' }
		]);
		const after = await filesOf(productId);
		expect(after.map(({ filename, position }) => ({ filename, position }))).toEqual(files.map(({ filename }, position) => ({ filename, position })));
		// The ZIP's row now holds the first image, so the link already sent delivers it.
		expect(after[0]!.id).toBe(old.assetId);
		expect(await client`select count(*)::int as n from app.download_grants where order_id = ${grantOrder}`).toEqual([{ n: 1 }]);
		expect(calls.at(-2)).toBe(`wait ${PREVIOUS_FILE_GRACE_MS}`);
		expect(calls.at(-1)).toBe(`remove ${old.storagePath}`);
		expect(objects.has(old.storagePath)).toBe(false);

		// The same list again changes nothing.
		calls.length = 0;
		const again = await syncProductFiles(handle, storage, { organizationSlug: orgSlug, productSlug: 'calcomania-sync', files });
		expect(again.changes.map((change) => change.outcome)).toEqual(['unchanged', 'unchanged', 'unchanged']);
		expect(calls).toEqual([]);

		// A shorter list in another order moves the kept files and removes the one left out.
		const second = after[1]!;
		const third = after[2]!;
		const next = await syncProductFiles(handle, storage, { organizationSlug: orgSlug, productSlug: 'calcomania-sync', files: [files[2]!, files[0]!] });
		expect(next.changes).toEqual([
			{ filename: 'TallerDemo-fondo-celular.png', outcome: 'moved' },
			{ filename: 'TallerDemo-calcomania-con-borde.png', outcome: 'moved' },
			{ filename: 'TallerDemo-calcomania.png', outcome: 'removed' }
		]);
		expect((await filesOf(productId)).map(({ id, position }) => ({ id, position }))).toEqual([
			{ id: third.id, position: 0 },
			{ id: old.assetId, position: 1 }
		]);
		expect(objects.has(second.storage_path)).toBe(false);
	});

	it('refuses a list with the same file twice or more than ten files, changing nothing', async () => {
		const { storage, calls } = fakeStorage();
		const twice = [
			{ filename: 'a.png', bytes: png('d') },
			{ filename: 'b.png', bytes: png('d') }
		];
		expect(await refusal(syncProductFiles(handle, storage, { organizationSlug: orgSlug, productSlug: 'checklist-digital', files: twice }))).toBe('b.png is the same file as a.png');
		const many = Array.from({ length: 11 }, (_, index) => ({ filename: `f${index}.png`, bytes: png(`m${index}`) }));
		expect(await refusal(syncProductFiles(handle, storage, { organizationSlug: orgSlug, productSlug: 'checklist-digital', files: many }))).toBe(
			'checklist-digital: 11 files; a product delivers at most 10'
		);
		expect(calls).toEqual([]);
	});
});
