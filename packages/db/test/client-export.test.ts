import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { parseKeyRing } from '@sortea/domain/server';
import { createDatabase, type DatabaseHandle } from '../src';
import { assertExportTarget, evaluatePackSource, exportClientPack, rewritePackSource, ClientExportRefusedError } from '../src/client-export';
import { loadClientPack, validateClientPack, type ClientPack, type ClientPackServices } from '../src/client-pack';
import { PRODUCT_ASSETS_PREFIX, scopedStore } from '../src/object-store';
import { fakeObjectStore } from './fake-object-store';

let handle: DatabaseHandle;
let client: postgres.Sql;
const root = mkdtempSync(join(tmpdir(), 'client-export-'));
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** What a client's pack.ts looks like before an export: hand-written hosts, members and campaign, stale content. */
function currentPackSource(slug: string): string {
	return `import type { ClientPack } from '../../packages/db/src/client-pack';

/** The pack as it was written by hand. */

// The brand colours, kept as a const.
const theme: ClientPack['theme'] = { defaultMode: 'light' };

// The campaign is authored here, never exported.
const rules = ['# Bases escritas a mano', '', 'Solo para la prueba.'].join('\\n');
export const pack: ClientPack = {
	slug: '${slug}',
	name: 'Nombre viejo',
	orderPrefix: 'TP',
	// Hosts and members are not in the database export.
	hosts: ['${slug}.test'],
	settings: {
		contact: { city: 'Rosario, Santa Fe' },
		social: {},
		delivery: { pickupEnabled: true, shippingEnabled: false, shippingFeeMinor: 0 },
		legal: { termsVersion: 'v1', privacyVersion: 'v1' }
	},
	theme,
	members: [{ email: 'owner@${slug}.local', role: 'org_owner' }],
	blocks: [
		// The brand block.
		{ key: 'brand', content: { logo: null, logoAlt: 'Taller de Prueba', tagline: 'Un taller de prueba.' } }
	],
	products: [],
	campaign: {
		slug: 'a-mano',
		title: 'Campaña escrita a mano',
		subtitle: 'Demostración',
		summary: 'No sale de la base de datos.',
		timezone: 'America/Argentina/Buenos_Aires',
		opensAt: '2026-10-20T12:00:00-03:00',
		closesAt: '2026-11-28T20:00:00-03:00',
		drawAt: '2026-11-28T22:00:00-03:00',
		isDemo: true,
		seo: { title: 'A mano', description: 'A mano.' },
		rulesMarkdown: rules,
		eligibility: { minAge: 18, residency: 'República Argentina', excluded: [] },
		chancesPerUnit: { manual: 3 },
		prizes: [{ kind: 'cash', title: '$1.000 en efectivo', declaredValueMinor: 100_000, quantity: 1, alternatesCount: 0, mechanism: 'quiniela' }],
		faqs: []
	}
};
`;
}

/** The organization in the database: content, catalog, and everything the export must leave out. */
function databasePack(slug: string): ClientPack {
	return {
		slug,
		name: 'Taller de Prueba',
		orderPrefix: 'TP',
		hosts: [`db-${slug}.test`],
		settings: {
			contact: { city: 'Córdoba, Córdoba', whatsapp: '5491123456789' },
			social: { instagram: 'https://www.instagram.com/taller.prueba/', facebook: 'https://www.facebook.com/TallerPrueba' },
			delivery: { pickupEnabled: true, shippingEnabled: true, shippingFeeMinor: 500_000 },
			legal: { termsVersion: 'v2', privacyVersion: 'v1' }
		},
		theme: { defaultMode: 'dark', radius: 8 },
		members: [{ email: `persona-miembro@${slug}.test`, role: 'org_owner' }],
		blocks: [
			{ key: 'brand', content: { logo: null, logoAlt: 'Taller de Prueba', tagline: 'Un taller de prueba.' } },
			{ key: 'home', content: { heroTitle: 'Bienvenidos', heroLead: 'Un taller de prueba para el exportador.' } },
			{ key: 'legal.terms', content: { version: 'v2', sections: [{ title: 'Borrador', body: 'Primera línea.\nSegunda línea.' }] } }
		],
		products: [
			{ slug: 'manual', name: 'Manual de prueba', description: 'Manual en PDF.', kind: 'digital', priceMinor: 5_000_000, sku: 'TP-MANUAL', asset: true, imageUrl: '/tenants/prueba/manual.webp' },
			{
				slug: 'remera',
				name: 'Remera de prueba',
				description: 'Remera de algodón.',
				kind: 'physical',
				priceMinor: 4_500_000,
				sku: 'TP-REMERA-S',
				variants: [
					{ sku: 'TP-REMERA-S', name: 'Talle S', stock: 5 },
					{ sku: 'TP-REMERA-M', name: 'Talle M', stock: 4 }
				]
			}
		],
		pitches: { manual: 'El manual en PDF.', remera: 'Elegí tu talle.' },
		siteFaqs: [{ question: '¿Hacen envíos?', answer: 'Sí, a todo el país.' }],
		campaign: {
			slug: 'de-la-base',
			title: 'Campaña de la base de datos',
			subtitle: 'Demostración',
			summary: 'Nunca se exporta.',
			timezone: 'America/Argentina/Buenos_Aires',
			opensAt: '2026-10-20T12:00:00-03:00',
			closesAt: '2026-11-28T20:00:00-03:00',
			drawAt: '2026-11-28T22:00:00-03:00',
			isDemo: true,
			seo: { title: 'Base', description: 'Base.' },
			rulesMarkdown: '# Bases de la base de datos',
			eligibility: { minAge: 18, residency: 'República Argentina', excluded: [] },
			chancesPerUnit: { manual: 14 },
			prizes: [{ kind: 'vehicle', title: 'Moto de la base de datos', declaredValueMinor: 10_000_000, quantity: 1, alternatesCount: 1, mechanism: 'quiniela' }],
			faqs: [{ question: '¿Pregunta de la campaña?', answer: 'Nunca se exporta.' }]
		}
	};
}

/** Loads the database side of a client and writes its current pack.ts, as on the owner's machine. */
async function client_(tag = randomUUID().slice(0, 8)) {
	const slug = `export-${tag}`;
	const { store, objects } = fakeObjectStore();
	const files = scopedStore(store, PRODUCT_ASSETS_PREFIX);
	const services: ClientPackServices = {
		ensureUser: async () => ({ id: randomUUID(), created: true }),
		uploadProductFile: (path, bytes, contentType) => files.put(path, bytes, { contentType }),
		paymentSimulator: { ring: parseKeyRing(`v1:${randomBytes(32).toString('base64')}`), webhookSecret: 'secreto-del-simulador' }
	};
	const loaded = await loadClientPack(handle, databasePack(slug), services);
	const organizationId = loaded.organizationId;
	// Personal and operational rows the export must never read into the pack.
	const [contact] = await client<{ id: string }[]>`
		insert into app.contacts (organization_id, first_name, last_name, email, phone) values (${organizationId}, 'Persona', 'Compradora', 'persona-compradora@example.test', '+5491100000000') returning id`;
	await client`insert into app.contact_identifiers (organization_id, contact_id, document_type, document_number) values (${organizationId}, ${contact!.id}, 'DNI', '30111222')`;
	const dir = join(root, slug);
	mkdirSync(dir, { recursive: true });
	const packFile = join(dir, 'pack.ts');
	writeFileSync(packFile, currentPackSource(slug));
	return { slug, organizationId, packFile, filesDir: join(dir, 'files'), files, objects };
}

async function everything(organizationId: string) {
	const tables = await client<{ table_name: string }[]>`
		select table_name from information_schema.columns where table_schema = 'app' and column_name = 'organization_id' group by table_name order by table_name`;
	const result: Record<string, unknown[]> = {};
	for (const { table_name } of tables) result[table_name] = await client.unsafe(`select * from app.${table_name} t where organization_id = $1 order by t::text`, [organizationId]);
	return result;
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

describe('exportClientPack', () => {
	it('writes the organization content into the pack and nothing personal, operational or of its campaigns, without writing the database', async () => {
		const target = await client_();
		const before = await everything(target.organizationId);

		const result = await exportClientPack(handle, { client: target.slug, packFile: target.packFile, filesDir: target.filesDir, productFiles: target.files });

		const source = readFileSync(target.packFile, 'utf8');
		const pack = await evaluatePackSource(source);
		expect(validateClientPack(pack)).toEqual([]);
		expect(Object.keys(pack).sort()).toEqual(['blocks', 'campaign', 'files', 'hosts', 'members', 'name', 'orderPrefix', 'pitches', 'products', 'settings', 'siteFaqs', 'slug', 'theme']);
		expect(pack.name).toBe('Taller de Prueba');
		expect(pack.settings).toEqual(databasePack(target.slug).settings);
		expect(pack.theme).toEqual({ defaultMode: 'dark', radius: 8 });
		expect(pack.blocks.map((block) => block.key)).toEqual(['brand', 'home', 'legal.terms']);
		expect(pack.blocks[2]!.content).toEqual({ version: 'v2', sections: [{ title: 'Borrador', body: 'Primera línea.\nSegunda línea.' }] });
		expect(pack.products).toEqual([
			{ slug: 'manual', name: 'Manual de prueba', description: 'Manual en PDF.', kind: 'digital', priceMinor: 5_000_000, sku: 'TP-MANUAL', imageUrl: '/tenants/prueba/manual.webp', asset: true },
			{
				slug: 'remera',
				name: 'Remera de prueba',
				description: 'Remera de algodón.',
				kind: 'physical',
				priceMinor: 4_500_000,
				// Variants keep the pack's order; without one (a new product), their creation order, then the SKU.
				sku: 'TP-REMERA-M',
				variants: [
					{ sku: 'TP-REMERA-M', name: 'Talle M', stock: 4 },
					{ sku: 'TP-REMERA-S', name: 'Talle S', stock: 5 }
				]
			}
		]);
		expect(pack.pitches).toEqual({ manual: 'El manual en PDF.', remera: 'Elegí tu talle.' });
		expect(pack.siteFaqs).toEqual([{ question: '¿Hacen envíos?', answer: 'Sí, a todo el país.' }]);

		// Hosts, members and the campaign stay exactly as they were written, comments included.
		expect(pack.hosts).toEqual([`${target.slug}.test`]);
		expect(pack.members).toEqual([{ email: `owner@${target.slug}.local`, role: 'org_owner' }]);
		expect(pack.campaign!.title).toBe('Campaña escrita a mano');
		expect(source).toContain(`\tcampaign: {\n\t\tslug: 'a-mano',`);
		expect(source).toContain("// The campaign is authored here, never exported.\nconst rules = ['# Bases escritas a mano', '', 'Solo para la prueba.'].join('\\n');");
		expect(source).toContain('// Hosts and members are not in the database export.');
		expect(source).toContain('// The brand colours, kept as a const.\nconst theme');

		for (const leaked of ['persona-miembro', 'persona-compradora', 'Compradora', '30111222', '+5491100000000', 'Campaña de la base de datos', 'Moto de la base de datos', '¿Pregunta de la campaña?', 'secreto-del-simulador', 'TEST-fake', 'pack_loaded', target.organizationId, `db-${target.slug}.test`]) {
			expect(source, leaked).not.toContain(leaked);
		}
		expect(await everything(target.organizationId)).toEqual(before);
		expect(result.written).toBe(true);
	});

	it('maps each digital product to its file, copied from the bucket under its sha256 prefix', async () => {
		const target = await client_();
		const [stored] = await client<{ storage_path: string }[]>`select storage_path from app.product_assets where organization_id = ${target.organizationId}`;
		const bytes = target.objects.get(`product-assets/${stored!.storage_path}`)!;

		const result = await exportClientPack(handle, { client: target.slug, packFile: target.packFile, filesDir: target.filesDir, productFiles: target.files });

		const pack = await evaluatePackSource(readFileSync(target.packFile, 'utf8'));
		expect(pack.files).toEqual({ manual: { filename: 'manual.pdf', sha256: sha(bytes), contentType: 'application/pdf' } });
		expect(readdirSync(target.filesDir)).toEqual([`${sha(bytes).slice(0, 16)}-manual.pdf`]);
		expect(readFileSync(join(target.filesDir, `${sha(bytes).slice(0, 16)}-manual.pdf`))).toEqual(Buffer.from(bytes));
		expect(result.files).toEqual([{ productSlug: 'manual', filename: 'manual.pdf', sha256: sha(bytes), sizeBytes: bytes.byteLength, copied: true }]);
	});

	// Owner feedback 2026-11-11b, S2: a product with several files is exported as their list, in order.
	it('maps a product with several files to their list, in order, and the pack loads them back', async () => {
		const target = await client_();
		const [stored] = await client<{ product_id: string; storage_path: string }[]>`select product_id, storage_path from app.product_assets where organization_id = ${target.organizationId}`;
		const manualBytes = target.objects.get(`product-assets/${stored!.storage_path}`)!;
		const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7]);
		const pngPath = `${target.organizationId}/${stored!.product_id}/${sha(png).slice(0, 16)}.png`;
		await target.files.put(pngPath, png, { contentType: 'image/png' });
		await client`insert into app.product_assets (organization_id, product_id, storage_path, filename, content_type, size_bytes, position)
			values (${target.organizationId}, ${stored!.product_id}, ${pngPath}, 'Fondo.png', 'image/png', ${png.byteLength}, 1)`;

		const result = await exportClientPack(handle, { client: target.slug, packFile: target.packFile, filesDir: target.filesDir, productFiles: target.files });

		const pack = (await evaluatePackSource(readFileSync(target.packFile, 'utf8'))) as ClientPack;
		expect(pack.files).toEqual({
			manual: [
				{ filename: 'manual.pdf', sha256: sha(manualBytes), contentType: 'application/pdf' },
				{ filename: 'Fondo.png', sha256: sha(png), contentType: 'image/png' }
			]
		});
		expect(readdirSync(target.filesDir).sort()).toEqual([`${sha(manualBytes).slice(0, 16)}-manual.pdf`, `${sha(png).slice(0, 16)}-Fondo.png`].sort());
		expect(result.files.map((file) => file.filename)).toEqual(['manual.pdf', 'Fondo.png']);
		expect(validateClientPack(pack)).toEqual([]);
	});

	it('changes nothing when run again without database changes, and says so', async () => {
		const target = await client_();
		const first = await exportClientPack(handle, { client: target.slug, packFile: target.packFile, filesDir: target.filesDir, productFiles: target.files });
		const written = readFileSync(target.packFile, 'utf8');

		const second = await exportClientPack(handle, { client: target.slug, packFile: target.packFile, filesDir: target.filesDir, productFiles: target.files });

		expect(first.summary).toEqual([
			'name: changed',
			'settings: 7 values changed (contact.city, contact.whatsapp, social.facebook, social.instagram, delivery.shippingEnabled, delivery.shippingFeeMinor, legal.termsVersion)',
			'theme: 2 values changed (defaultMode, radius)',
			'blocks: 2 added (home, legal.terms)',
			'products: 2 added (manual, remera)',
			'files: 1 added (manual)',
			'pitches: 2 added (manual, remera)',
			'siteFaqs: 1 added'
		]);
		expect(second).toMatchObject({ written: false, summary: ['no changes'] });
		expect(second.files).toMatchObject([{ productSlug: 'manual', copied: false }]);
		expect(readFileSync(target.packFile, 'utf8')).toBe(written);
	});

	it('refuses an organization the database does not have', async () => {
		const target = await client_();
		const packFile = join(root, 'nadie-aca.ts');
		writeFileSync(packFile, currentPackSource('nadie-aca'));
		await expect(exportClientPack(handle, { client: 'nadie-aca', packFile, filesDir: join(root, 'nadie-aca-files'), productFiles: target.files })).rejects.toThrow(
			new ClientExportRefusedError('The database has no organization nadie-aca.')
		);
	});
});

describe('the export target', () => {
	it('refuses anything but the local database and bucket', () => {
		expect(() => assertExportTarget('postgresql://postgres:postgres@127.0.0.1:54322/postgres', 'http://127.0.0.1:9000')).not.toThrow();
		expect(() => assertExportTarget('postgresql://u:p@postgres.railway.internal:5432/railway', 'http://127.0.0.1:9000')).toThrow(
			new ClientExportRefusedError('pnpm client:export reads only the local database; DATABASE_URL points to postgres.railway.internal.')
		);
		expect(() => assertExportTarget('postgresql://postgres:postgres@127.0.0.1:54322/postgres', 'https://storage.example.test')).toThrow(
			new ClientExportRefusedError('pnpm client:export reads only the local bucket; S3_ENDPOINT points to storage.example.test.')
		);
	});
});

describe('rewritePackSource', () => {
	const source = `import type { ClientPack } from './x';

// Kept: a comment above a const used once.
const theme = { radius: 6, density: 'comfortable' };
const shared = 'v1';
export const pack = {
	// Kept: a comment above a property.
	name: 'Viejo',
	theme,
	legal: { termsVersion: shared, privacyVersion: shared },
	body: ['uno', 'dos'].join('\\n'),
	products: [
		// The manual.
		{ slug: 'manual', priceMinor: 5_000_000 },
		{ slug: 'remera', priceMinor: 4_500_000 }
	]
};
`;

	it('changes only the values that differ and keeps comments, consts and formatting', async () => {
		const before = await evaluatePackSource(source);
		const next = {
			...before,
			theme: { radius: 8, density: 'comfortable' },
			legal: { termsVersion: 'v2', privacyVersion: 'v1' },
			body: 'uno\ntres',
			products: [{ slug: 'manual', priceMinor: 5_500_000 }, { slug: 'remera', priceMinor: 4_500_000 }, { slug: 'gorra', priceMinor: 20_000 }]
		};

		const rewritten = rewritePackSource(source, before as never, next as never);

		expect(await evaluatePackSource(rewritten)).toEqual(next);
		expect(rewritten).toBe(`import type { ClientPack } from './x';

// Kept: a comment above a const used once.
const theme = { radius: 8, density: 'comfortable' };
const shared = 'v1';
export const pack = {
	// Kept: a comment above a property.
	name: 'Viejo',
	theme,
	legal: { termsVersion: 'v2', privacyVersion: shared },
	body: ['uno', 'tres'].join('\\n'),
	products: [
		// The manual.
		{ slug: 'manual', priceMinor: 5_500_000 },
		{ slug: 'remera', priceMinor: 4_500_000 },
		{ slug: 'gorra', priceMinor: 20_000 }
	]
};
`);
		expect(rewritePackSource(rewritten, next as never, next as never)).toBe(rewritten);
	});

	it('leaves the file byte for byte when nothing differs', async () => {
		expect(rewritePackSource(source, (await evaluatePackSource(source)) as never, (await evaluatePackSource(source)) as never)).toBe(source);
	});
});

// The real pack of the private repository is exported against the owner's database, never in tests.
it.skipIf(!existsSync(join(import.meta.dirname, '../../../clients')))('evaluates the private client packs the export rewrites', async () => {
	const dir = join(import.meta.dirname, '../../../clients');
	for (const name of readdirSync(dir).filter((entry) => existsSync(join(dir, entry, 'pack.ts')))) {
		const pack = await evaluatePackSource(readFileSync(join(dir, name, 'pack.ts'), 'utf8'));
		expect(pack.slug, name).toBe(name);
	}
});
