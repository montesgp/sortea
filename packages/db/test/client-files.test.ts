import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createDatabase, type DatabaseHandle } from '../src';
import { declaredFileReader, incomingPath, packFileName, removeIncomingFiles, uploadIncomingFiles } from '../src/client-files';
import { ClientPackRefusedError, loadClientPack, validateClientPack, type ClientPack, type ClientPackServices, type ProductFileSeed } from '../src/client-pack';
import { PRODUCT_ASSETS_PREFIX, scopedStore } from '../src/object-store';
import { fakeObjectStore } from './fake-object-store';

let handle: DatabaseHandle;
let client: postgres.Sql;
const root = mkdtempSync(join(tmpdir(), 'client-files-'));

const pdf = (text: string) => new TextEncoder().encode(`%PDF-1.4\n% ${text}\n%%EOF\n`);
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

const manualBytes = pdf('the real manual');
const manualFile: ProductFileSeed = { filename: 'Manual-de-prueba.pdf', sha256: sha(manualBytes), contentType: 'application/pdf' };

/** A pack with one digital product whose real file it declares, under fresh slug and host. */
function filePack(overrides: Partial<ClientPack> = {}): ClientPack {
	const tag = randomUUID().slice(0, 8);
	return {
		slug: `files-${tag}`,
		name: 'Taller de Archivos',
		orderPrefix: 'TA',
		hosts: [`files-${tag}.test`],
		settings: {
			contact: {},
			social: {},
			delivery: { pickupEnabled: true, shippingEnabled: false, shippingFeeMinor: 0 },
			legal: { termsVersion: 'v1', privacyVersion: 'v1' }
		},
		theme: {},
		members: [],
		blocks: [],
		products: [
			{ slug: 'manual', name: 'Manual de prueba', description: 'Manual en PDF.', kind: 'digital', priceMinor: 5_000_000, sku: 'TA-MANUAL', asset: true },
			{ slug: 'remera', name: 'Remera de prueba', description: 'Remera de algodón.', kind: 'physical', priceMinor: 4_500_000, sku: 'TA-REMERA' }
		],
		files: { manual: manualFile },
		...overrides
	};
}

/** A directory laid out like `clients/<client>/files`. */
function filesDir(entries: Record<string, Uint8Array>): string {
	const dir = join(root, randomUUID());
	mkdirSync(dir, { recursive: true });
	for (const [name, bytes] of Object.entries(entries)) writeFileSync(join(dir, name), bytes);
	return dir;
}

function services(readDeclaredFile: ClientPackServices['readDeclaredFile'], uploads: Map<string, Uint8Array> = new Map()): ClientPackServices {
	return {
		ensureUser: async () => ({ id: randomUUID(), created: true }),
		uploadProductFile: async (path, bytes) => void uploads.set(path, bytes),
		...(readDeclaredFile ? { readDeclaredFile } : {})
	};
}

async function refusal(promise: Promise<unknown>): Promise<string> {
	const error = await promise.then(
		() => null,
		(caught: unknown) => caught
	);
	expect(error).toBeInstanceOf(ClientPackRefusedError);
	return (error as Error).message;
}

async function organizationBySlug(slug: string) {
	const [row] = await client<{ id: string }[]>`select id from app.organizations where slug = ${slug}`;
	return row;
}

async function assetsOf(organizationId: string) {
	return client<{ slug: string; storage_path: string; filename: string; content_type: string; size_bytes: number; product_id: string }[]>`
		select p.slug, a.product_id, a.storage_path, a.filename, a.content_type, a.size_bytes from app.product_assets a join app.products p on p.id = a.product_id
		where a.organization_id = ${organizationId} order by p.slug`;
}

beforeAll(() => {
	handle = createDatabase(inject('databaseUrl'), { max: 2 });
	client = postgres(inject('databaseUrl'), { max: 1, onnotice: () => {} });
});

afterAll(async () => {
	await client.end();
	await handle.close();
	rmSync(root, { recursive: true, force: true });
});

describe('declared product files', () => {
	it('keeps each file under its sha256 prefix and the download name, and in the bucket under its full sha256', () => {
		expect(packFileName(manualFile)).toBe(`${manualFile.sha256.slice(0, 16)}-Manual-de-prueba.pdf`);
		expect(incomingPath(manualFile)).toBe(`_incoming/${manualFile.sha256}`);
	});

	it('refuses a mapping that does not describe a digital product file', () => {
		const pack = filePack({
			files: {
				remera: manualFile,
				ghost: manualFile,
				manual: { filename: 'Manual de prueba.pdf', sha256: 'abc', contentType: 'application/zip' } as unknown as ProductFileSeed
			}
		});
		expect(validateClientPack(pack)).toEqual([
			'files.remera: remera is a physical product; only digital products deliver files',
			'files.ghost: no product ghost',
			'files.manual: sha256 must be 64 lowercase hexadecimal characters',
			'files.manual: Manual de prueba.pdf may only use letters A-Z, digits, dots, dashes and underscores',
			'files.manual: a application/zip file must end in .zip'
		]);
		expect(validateClientPack(filePack())).toEqual([]);
	});

	it('loads the real file from the pack directory, named by its hash like pnpm db:product-file', async () => {
		const pack = filePack();
		const uploads = new Map<string, Uint8Array>();
		const read = declaredFileReader({ dir: filesDir({ [packFileName(manualFile)]: manualBytes }), label: 'clients/x/files' });

		const result = await loadClientPack(handle, pack, services(read, uploads), { realFilesOnly: true });

		const [asset] = await assetsOf(result.organizationId);
		expect(asset).toEqual({
			slug: 'manual',
			product_id: asset!.product_id,
			storage_path: `${result.organizationId}/${asset!.product_id}/${manualFile.sha256.slice(0, 16)}.pdf`,
			filename: 'Manual-de-prueba.pdf',
			content_type: 'application/pdf',
			size_bytes: manualBytes.byteLength
		});
		expect([...uploads.keys()]).toEqual([asset!.storage_path]);
		expect(uploads.get(asset!.storage_path)).toEqual(manualBytes);
		expect(result.files).toEqual([{ productSlug: 'manual', filename: 'Manual-de-prueba.pdf', source: 'local', location: `clients/x/files/${packFileName(manualFile)}` }]);
	});

	it('refuses a local copy whose sha256 differs from the pack, and writes nothing', async () => {
		const pack = filePack();
		const uploads = new Map<string, Uint8Array>();
		const tampered = pdf('another manual');
		const read = declaredFileReader({ dir: filesDir({ [packFileName(manualFile)]: tampered }), label: 'clients/x/files' });

		expect(await refusal(loadClientPack(handle, pack, services(read, uploads)))).toBe(
			`manual: clients/x/files/${packFileName(manualFile)} has sha256 ${sha(tampered)}, not the ${manualFile.sha256} the pack declares. Export the pack again or put the right file in place.`
		);
		expect(await organizationBySlug(pack.slug)).toBeUndefined();
		expect(uploads.size).toBe(0);
	});

	it('refuses a deployed load when a declared file is missing, and writes nothing', async () => {
		const pack = filePack();
		const uploads = new Map<string, Uint8Array>();
		const read = declaredFileReader({ dir: filesDir({}), label: 'clients/x/files', incoming: scopedStore(fakeObjectStore().store, PRODUCT_ASSETS_PREFIX) });

		expect(await refusal(loadClientPack(handle, pack, services(read, uploads), { realFilesOnly: true }))).toBe(
			`manual: its file Manual-de-prueba.pdf is not on this machine nor uploaded to the bucket; run pnpm client:upload-files ${pack.slug} first. A deployed database never gets a sample file.`
		);
		expect(await organizationBySlug(pack.slug)).toBeUndefined();
		expect(uploads.size).toBe(0);
	});

	it('refuses a deployed load of a digital product without a declared file, and writes nothing', async () => {
		const pack = filePack({ files: {} });

		expect(await refusal(loadClientPack(handle, pack, services(undefined), { realFilesOnly: true }))).toBe(
			`manual: a deployed database needs the product's real file; declare it in the pack's files (pnpm client:export ${pack.slug}). A deployed database never gets a sample file.`
		);
		expect(await organizationBySlug(pack.slug)).toBeUndefined();
	});

	it('on a local database, puts the sample PDF behind a declared file that is missing, and says so', async () => {
		const pack = filePack();
		const uploads = new Map<string, Uint8Array>();

		const result = await loadClientPack(handle, pack, services(declaredFileReader({ dir: filesDir({}), label: 'clients/x/files' }), uploads));

		const [asset] = await assetsOf(result.organizationId);
		expect(asset).toMatchObject({ slug: 'manual', filename: 'manual.pdf', content_type: 'application/pdf' });
		expect(new TextDecoder().decode(uploads.get(asset!.storage_path)!.subarray(0, 5))).toBe('%PDF-');
		expect(result.files).toEqual([{ productSlug: 'manual', filename: 'manual.pdf', source: 'sample' }]);
	});
});

// Owner feedback 2026-11-11b, S2: a product may map to a list of files, each with its own download link.
describe('a product declaring several files', () => {
	const png = (text: string) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new TextEncoder().encode(text)]);
	const seed = (filename: string, bytes: Uint8Array): ProductFileSeed => ({ filename, sha256: sha(bytes), contentType: 'image/png' });
	const borde = png('con borde');
	const fondo = png('fondo');
	const images = [seed('Calcomania-con-borde.png', borde), seed('Fondo-celular.png', fondo)];
	const listPack = () => filePack({ files: { manual: images } });

	it('validates each file of the list and the list as a whole, keeping the single-file form valid', () => {
		const big = Array.from({ length: 11 }, (_, index) => seed(`f${index}.png`, png(`f${index}`)));
		expect(
			validateClientPack(
				filePack({
					files: {
						manual: [images[0]!, { ...images[0]!, filename: 'Otra.png' }, { filename: 'Foto.webp', sha256: sha(png('w')), contentType: 'image/webp' } as unknown as ProductFileSeed, { ...images[1]!, filename: 'Fondo.jpg' }]
					}
				})
			)
		).toEqual([
			'files.manual[1]: the same file as files.manual[0]',
			'files.manual[2]: image/webp is not a PDF, ZIP, PNG or JPEG content type',
			'files.manual[3]: a image/png file must end in .png'
		]);
		expect(validateClientPack(filePack({ files: { manual: [] } }))).toEqual(['files.manual: list at least one file']);
		expect(validateClientPack(filePack({ files: { manual: big } }))).toEqual(['files.manual: 11 files; a product delivers at most 10']);
		expect(validateClientPack(filePack({ files: { manual: [images[0]!, { ...images[1]!, filename: 'Calcomania-con-borde.png' }] } }))).toEqual([
			'files.manual[1]: Calcomania-con-borde.png is the download name of files.manual[0] too'
		]);
		expect(validateClientPack(listPack())).toEqual([]);
		expect(validateClientPack(filePack())).toEqual([]);
	});

	it('loads every file of the list, in order, each named by its hash', async () => {
		const pack = listPack();
		const uploads = new Map<string, Uint8Array>();
		const read = declaredFileReader({ dir: filesDir({ [packFileName(images[0]!)]: borde, [packFileName(images[1]!)]: fondo }), label: 'clients/x/files' });

		const result = await loadClientPack(handle, pack, services(read, uploads), { realFilesOnly: true });

		const rows = await client<{ filename: string; storage_path: string; content_type: string; position: number }[]>`
			select filename, storage_path, content_type, position from app.product_assets where organization_id = ${result.organizationId} order by position`;
		const [productId] = rows.map((row) => row.storage_path.split('/')[1]);
		expect(rows).toEqual([
			{ filename: 'Calcomania-con-borde.png', storage_path: `${result.organizationId}/${productId}/${images[0]!.sha256.slice(0, 16)}.png`, content_type: 'image/png', position: 0 },
			{ filename: 'Fondo-celular.png', storage_path: `${result.organizationId}/${productId}/${images[1]!.sha256.slice(0, 16)}.png`, content_type: 'image/png', position: 1 }
		]);
		expect(uploads.get(rows[1]!.storage_path)).toEqual(fondo);
		expect(result.files).toEqual([
			{ productSlug: 'manual', filename: 'Calcomania-con-borde.png', source: 'local', location: `clients/x/files/${packFileName(images[0]!)}` },
			{ productSlug: 'manual', filename: 'Fondo-celular.png', source: 'local', location: `clients/x/files/${packFileName(images[1]!)}` }
		]);
	});

	it('refuses a deployed load when one file of the list is missing, and writes nothing', async () => {
		const pack = listPack();
		const read = declaredFileReader({ dir: filesDir({ [packFileName(images[0]!)]: borde }), label: 'clients/x/files' });

		expect(await refusal(loadClientPack(handle, pack, services(read), { realFilesOnly: true }))).toBe(
			`manual: its file Fondo-celular.png is not on this machine nor uploaded to the bucket; run pnpm client:upload-files ${pack.slug} first. A deployed database never gets a sample file.`
		);
		expect(await organizationBySlug(pack.slug)).toBeUndefined();
	});

	it('uploads every file of the list to _incoming and removes each copy the load used', async () => {
		const pack = listPack();
		const { store, objects } = fakeObjectStore();
		const files = scopedStore(store, PRODUCT_ASSETS_PREFIX);

		expect(await uploadIncomingFiles(pack, filesDir({ [packFileName(images[0]!)]: borde, [packFileName(images[1]!)]: fondo }), files)).toEqual([
			{ productSlug: 'manual', filename: 'Calcomania-con-borde.png', sizeBytes: borde.byteLength, path: `_incoming/${images[0]!.sha256}`, outcome: 'uploaded' },
			{ productSlug: 'manual', filename: 'Fondo-celular.png', sizeBytes: fondo.byteLength, path: `_incoming/${images[1]!.sha256}`, outcome: 'uploaded' }
		]);

		const read = declaredFileReader({ dir: join(root, 'not-in-this-image'), label: 'clients/x/files', incoming: files });
		const result = await loadClientPack(handle, pack, { ...services(read), uploadProductFile: (path, bytes, contentType) => files.put(path, bytes, { contentType }) }, { realFilesOnly: true });
		expect(await removeIncomingFiles(files, pack, result)).toEqual([`_incoming/${images[0]!.sha256}`, `_incoming/${images[1]!.sha256}`]);
		expect([...objects.keys()].filter((key) => key.includes('_incoming'))).toEqual([]);
		expect([...objects.keys()]).toHaveLength(2);
	});
});

describe('files for a deployed environment', () => {
	it('uploads each declared file to product-assets/_incoming/<sha256> once', async () => {
		const pack = filePack();
		const { store, objects, calls } = fakeObjectStore();
		const dir = filesDir({ [packFileName(manualFile)]: manualBytes });

		expect(await uploadIncomingFiles(pack, dir, scopedStore(store, PRODUCT_ASSETS_PREFIX))).toEqual([
			{ productSlug: 'manual', filename: 'Manual-de-prueba.pdf', sizeBytes: manualBytes.byteLength, path: `_incoming/${manualFile.sha256}`, outcome: 'uploaded' }
		]);
		expect(objects.get(`product-assets/_incoming/${manualFile.sha256}`)).toEqual(manualBytes);
		expect(await uploadIncomingFiles(pack, dir, scopedStore(store, PRODUCT_ASSETS_PREFIX))).toMatchObject([{ outcome: 'present' }]);
		expect(calls).toEqual([`put product-assets/_incoming/${manualFile.sha256} application/pdf`]);
	});

	it('refuses to upload a file that is missing or differs from the pack, and uploads nothing', async () => {
		const pack = filePack();
		const { store, objects } = fakeObjectStore();

		expect(await refusal(uploadIncomingFiles(pack, filesDir({}), scopedStore(store, PRODUCT_ASSETS_PREFIX)))).toBe(
			`manual: no ${packFileName(manualFile)} in the pack's files directory; run pnpm client:export ${pack.slug} on the machine with the local database.`
		);
		const tampered = pdf('another manual');
		expect(await refusal(uploadIncomingFiles(pack, filesDir({ [packFileName(manualFile)]: tampered }), scopedStore(store, PRODUCT_ASSETS_PREFIX)))).toBe(
			`manual: ${packFileName(manualFile)} has sha256 ${sha(tampered)}, not the ${manualFile.sha256} the pack declares. Export the pack again or put the right file in place.`
		);
		expect(objects.size).toBe(0);
	});

	it('moves an uploaded file from _incoming to the product, checking its sha256', async () => {
		const pack = filePack();
		const { store, objects } = fakeObjectStore({ [`product-assets/_incoming/${manualFile.sha256}`]: manualBytes });
		const files = scopedStore(store, PRODUCT_ASSETS_PREFIX);
		const read = declaredFileReader({ dir: join(root, 'not-in-this-image'), label: 'clients/x/files', incoming: files });
		const loadServices: ClientPackServices = { ...services(read), uploadProductFile: (path, bytes, contentType) => files.put(path, bytes, { contentType }) };

		const result = await loadClientPack(handle, pack, loadServices, { realFilesOnly: true });
		await removeIncomingFiles(files, pack, result);

		const [asset] = await assetsOf(result.organizationId);
		expect(asset).toMatchObject({ slug: 'manual', filename: 'Manual-de-prueba.pdf', size_bytes: manualBytes.byteLength });
		expect([...objects.keys()]).toEqual([`product-assets/${asset!.storage_path}`]);
		expect(objects.get(`product-assets/${asset!.storage_path}`)).toEqual(manualBytes);
		expect(result.files).toEqual([{ productSlug: 'manual', filename: 'Manual-de-prueba.pdf', source: 'incoming', location: `bucket product-assets/_incoming/${manualFile.sha256}` }]);
	});

	it('refuses an _incoming file whose sha256 differs, writes nothing and leaves it for inspection', async () => {
		const pack = filePack();
		const wrong = pdf('a different upload');
		const { store, objects } = fakeObjectStore({ [`product-assets/_incoming/${manualFile.sha256}`]: wrong });
		const files = scopedStore(store, PRODUCT_ASSETS_PREFIX);
		const read = declaredFileReader({ dir: join(root, 'not-in-this-image'), label: 'clients/x/files', incoming: files });
		const loadServices: ClientPackServices = { ...services(read), uploadProductFile: (path, bytes, contentType) => files.put(path, bytes, { contentType }) };

		expect(await refusal(loadClientPack(handle, pack, loadServices, { realFilesOnly: true }))).toBe(
			`manual: bucket product-assets/_incoming/${manualFile.sha256} has sha256 ${sha(wrong)}, not the ${manualFile.sha256} the pack declares. Export the pack again or put the right file in place.`
		);
		expect(await organizationBySlug(pack.slug)).toBeUndefined();
		expect([...objects.keys()]).toEqual([`product-assets/_incoming/${manualFile.sha256}`]);
	});
});
