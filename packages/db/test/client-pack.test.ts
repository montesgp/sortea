import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { parseKeyRing } from '@sortea/domain/server';
import { createDatabase, schema as s, type DatabaseHandle } from '../src';
import { ClientPackRefusedError, loadClientPack, validateClientPack, type ClientPack, type ClientPackServices } from '../src/client-pack';
import { pistaSurPack } from '../src/packs/pista-sur';
import { tallerDemoPack } from '../src/packs/taller-demo';

let handle: DatabaseHandle;
let client: postgres.Sql;

const ring = parseKeyRing(`v1:${randomBytes(32).toString('base64')}`);

/** Users and storage live outside the database; the tests record what the loader asks of them. */
function fakeServices(options: { simulator?: boolean } = {}) {
	const users = new Map<string, string>();
	const uploads: string[] = [];
	const services: ClientPackServices = {
		async ensureUser(email) {
			const known = users.get(email);
			if (known) return { id: known, created: false };
			const id = randomUUID();
			users.set(email, id);
			return { id, created: true };
		},
		async uploadProductFile(path, bytes, contentType) {
			expect(bytes.byteLength).toBeGreaterThan(0);
			uploads.push(`${path} ${contentType}`);
		},
		...(options.simulator === false ? {} : { paymentSimulator: { ring, webhookSecret: 'dev-webhook-secret' } })
	};
	return { services, users, uploads };
}

/** A small pack with every part the loader handles, under fresh slug and hosts. */
function samplePack(overrides: Partial<ClientPack> = {}): ClientPack {
	const tag = randomUUID().slice(0, 8);
	return {
		slug: `pack-${tag}`,
		name: 'Taller de Prueba',
		orderPrefix: 'TP',
		hosts: [`pack-${tag}.test`, `www.pack-${tag}.test`],
		settings: {
			contact: { city: 'Rosario, Santa Fe', whatsapp: '5491123456789' },
			social: { instagram: 'https://www.instagram.com/taller.prueba/' },
			delivery: { pickupEnabled: true, shippingEnabled: false, shippingFeeMinor: 0 },
			legal: { termsVersion: 'v1', privacyVersion: 'v1' }
		},
		theme: { defaultMode: 'light', light: { accent: '#1747C9', accentText: '#FFFFFF' } },
		members: [
			{ email: `owner@${tag}.test`, role: 'org_owner' },
			{ email: `operador@${tag}.test`, role: 'campaign_operator' }
		],
		blocks: [
			{ key: 'brand', content: { logo: null, logoAlt: 'Taller de Prueba', tagline: 'Un taller de prueba.' } },
			{ key: 'home', content: { heroTitle: 'Bienvenidos', heroLead: 'Un taller de prueba para el cargador.' } },
			{ key: 'legal.terms', content: { version: 'v1', sections: [{ title: 'Borrador', body: 'Términos de prueba.' }] } }
		],
		products: [
			{ slug: 'manual', name: 'Manual de prueba', description: 'Manual en PDF para probar el cargador.', kind: 'digital', priceMinor: 5_000_000, sku: 'TP-MANUAL', asset: true },
			{
				slug: 'remera',
				name: 'Remera de prueba',
				description: 'Remera de algodón para probar talles.',
				kind: 'physical',
				priceMinor: 4_500_000,
				sku: 'TP-REMERA-S',
				variants: [
					{ sku: 'TP-REMERA-S', name: 'Talle S', stock: 5 },
					{ sku: 'TP-REMERA-M', name: 'Talle M', stock: 5 }
				]
			}
		],
		pitches: { manual: 'El manual en PDF.', remera: 'Elegí tu talle.' },
		siteFaqs: [{ question: '¿Hacen envíos?', answer: 'No, solo retiro en el taller.' }],
		campaign: {
			slug: 'demo',
			title: 'Campaña de prueba',
			subtitle: 'Campaña de demostración',
			summary: 'Una campaña para probar el cargador.',
			timezone: 'America/Argentina/Buenos_Aires',
			opensAt: '2026-10-20T12:00:00-03:00',
			closesAt: '2026-11-28T20:00:00-03:00',
			drawAt: '2026-11-28T22:00:00-03:00',
			isDemo: true,
			seo: { title: 'Campaña de prueba', description: 'Campaña de demostración.' },
			rulesMarkdown: '# Bases de prueba',
			eligibility: { minAge: 18, residency: 'República Argentina', excluded: ['Personal del taller'] },
			chancesPerUnit: { manual: 14, remera: 11 },
			prizes: [{ kind: 'cash', title: '$100.000 en efectivo', declaredValueMinor: 10_000_000, quantity: 2, alternatesCount: 1, mechanism: 'quiniela' }],
			faqs: [{ question: '¿Cómo participo?', answer: 'Comprando un producto que da chances.' }]
		},
		...overrides
	};
}

async function organizationBySlug(slug: string) {
	const [row] = await client<{ id: string; name: string; settings: Record<string, unknown> }[]>`select id, name, settings from app.organizations where slug = ${slug}`;
	return row;
}

/** Everything a load can write for one organization, to prove what changed and what did not. */
async function snapshot(organizationId: string) {
	const tables = ['organization_domains', 'organization_themes', 'organization_members', 'organization_integrations', 'cms_blocks', 'cms_block_revisions', 'products', 'product_variants', 'product_assets', 'offers', 'offer_items', 'campaigns', 'campaign_approvals', 'campaign_rule_versions', 'prizes', 'campaign_faqs', 'audit_events'];
	const result: Record<string, unknown[]> = {};
	for (const table of tables) {
		result[table] = await client.unsafe(`select * from app.${table} t where organization_id = $1 order by t::text`, [organizationId]);
	}
	const [organization] = await client`select * from app.organizations where id = ${organizationId}`;
	return { organization, tables: result };
}

async function refusal(promise: Promise<unknown>): Promise<string> {
	const error = await promise.then(
		() => null,
		(caught: unknown) => caught
	);
	expect(error).toBeInstanceOf(ClientPackRefusedError);
	return (error as Error).message;
}

/** Another organization the loader must never touch. */
let neighbour: { id: string; host: string };

beforeAll(async () => {
	handle = createDatabase(inject('databaseUrl'), { max: 2 });
	client = postgres(inject('databaseUrl'), { max: 1, onnotice: () => {} });
	const id = randomUUID();
	const host = `neighbour-${id.slice(0, 8)}.test`;
	await handle.withPlatform(async (db) => {
		await db.insert(s.organizations).values({
			id,
			slug: `neighbour-${id.slice(0, 8)}`,
			name: 'Vecina',
			orderPrefix: 'VE',
			settings: { contact: {}, social: {}, delivery: { pickupEnabled: false, shippingEnabled: false, shippingFeeMinor: 0 }, legal: { termsVersion: 't', privacyVersion: 'p' } }
		});
		await db.insert(s.organizationDomains).values({ organizationId: id, hostname: host, isPrimary: true });
	});
	neighbour = { id, host };
});

afterAll(async () => {
	await client.end();
	await handle.close();
});

describe('loadClientPack', () => {
	it('creates a missing organization with its hosts, members, content, catalog and demo campaign, never granting approvals', async () => {
		const pack = samplePack();
		const { services, users, uploads } = fakeServices();
		const before = await snapshot(neighbour.id);

		const result = await loadClientPack(handle, pack, services);

		const org = await organizationBySlug(pack.slug);
		expect(org).toBeDefined();
		expect(result).toEqual({ outcome: 'created', organizationId: org!.id, primaryHost: pack.hosts[0], hosts: pack.hosts, createdUsers: pack.members.map((member) => member.email), changes: [] });
		expect(org!.name).toBe('Taller de Prueba');
		expect(org!.settings).toEqual(pack.settings);

		const domains = await client<{ hostname: string; is_primary: boolean; verified: boolean }[]>`
			select hostname, is_primary, verified_at is not null as verified from app.organization_domains where organization_id = ${org!.id} order by is_primary desc, hostname`;
		expect(domains).toEqual([
			{ hostname: pack.hosts[0], is_primary: true, verified: true },
			{ hostname: pack.hosts[1], is_primary: false, verified: true }
		]);
		const members = await client`select email, role, user_id from app.organization_members where organization_id = ${org!.id} order by email`;
		expect(members).toEqual([
			{ email: pack.members[1]!.email, role: 'campaign_operator', user_id: users.get(pack.members[1]!.email) },
			{ email: pack.members[0]!.email, role: 'org_owner', user_id: users.get(pack.members[0]!.email) }
		]);
		const [theme] = await client`select tokens, version, is_active from app.organization_themes where organization_id = ${org!.id}`;
		expect(theme).toEqual({ tokens: pack.theme, version: 1, is_active: true });

		// Blocks are published as the site renders them, with their first revision.
		const blocks = await client<{ key: string; version: number; published: boolean; content: Record<string, unknown> }[]>`
			select key, version, published_at is not null as published, content from app.cms_blocks where organization_id = ${org!.id} order by key`;
		expect(blocks.map(({ key, version, published }) => ({ key, version, published }))).toEqual([
			{ key: 'brand', version: 1, published: true },
			{ key: 'home', version: 1, published: true },
			{ key: 'legal.terms', version: 1, published: true }
		]);
		expect(blocks.find((block) => block.key === 'home')!.content).toMatchObject({ heroTitle: 'Bienvenidos', heroStyle: 'simple', services: [] });
		const revisions = await client`select key, version from app.cms_block_revisions where organization_id = ${org!.id} order by key`;
		expect(revisions).toEqual([
			{ key: 'brand', version: 1 },
			{ key: 'home', version: 1 },
			{ key: 'legal.terms', version: 1 }
		]);

		const variants = await client`
			select p.slug, p.status, v.sku, v.name, v.price_minor::int as price_minor, v.stock from app.product_variants v join app.products p on p.id = v.product_id
			where v.organization_id = ${org!.id} order by v.sku`;
		expect(variants).toEqual([
			{ slug: 'manual', status: 'active', sku: 'TP-MANUAL', name: 'Manual de prueba', price_minor: 5_000_000, stock: null },
			{ slug: 'remera', status: 'active', sku: 'TP-REMERA-M', name: 'Talle M', price_minor: 4_500_000, stock: 5 },
			{ slug: 'remera', status: 'active', sku: 'TP-REMERA-S', name: 'Talle S', price_minor: 4_500_000, stock: 5 }
		]);
		const assets = await client<{ storage_path: string; filename: string }[]>`select storage_path, filename from app.product_assets where organization_id = ${org!.id}`;
		expect(assets).toHaveLength(1);
		expect(assets[0]!.filename).toBe('manual.pdf');
		expect(uploads).toEqual([`${assets[0]!.storage_path} application/pdf`]);
		const suggestions = await client`
			select a.slug as anchor, o.title, i.pitch from app.offer_items i join app.offers o on o.id = i.offer_id join app.products a on a.id = o.anchor_product_id
			where i.organization_id = ${org!.id} order by a.slug`;
		expect(suggestions).toEqual([
			{ anchor: 'manual', title: 'Sumá a tu pedido', pitch: 'Elegí tu talle.' },
			{ anchor: 'remera', title: 'Sumá a tu pedido', pitch: 'El manual en PDF.' }
		]);

		const [campaign] = await client`select id, slug, status, is_demo, required_approvals from app.campaigns where organization_id = ${org!.id}`;
		expect(campaign).toMatchObject({ slug: 'demo', status: 'published', is_demo: true, required_approvals: ['legal', 'psp'] });
		const approvals = await client`select kind, status, decided_at from app.campaign_approvals where campaign_id = ${campaign!.id} order by kind`;
		expect(approvals).toEqual([
			{ kind: 'legal', status: 'pending', decided_at: null },
			{ kind: 'psp', status: 'pending', decided_at: null }
		]);
		const [rules] = await client<{ status: string; entry_rule: { entriesPerUnit: Record<string, number> } }[]>`
			select status, entry_rule from app.campaign_rule_versions where campaign_id = ${campaign!.id}`;
		expect(rules!.status).toBe('draft');
		expect(Object.values(rules!.entry_rule.entriesPerUnit).sort((a, b) => a - b)).toEqual([11, 11, 14]);
		expect(await client`select title, quantity, mechanism from app.prizes where campaign_id = ${campaign!.id}`).toEqual([{ title: '$100.000 en efectivo', quantity: 2, mechanism: 'quiniela' }]);
		const faqs = await client`select question, campaign_id is null as site from app.campaign_faqs where organization_id = ${org!.id} order by question`;
		expect(faqs).toEqual([
			{ question: '¿Cómo participo?', site: false },
			{ question: '¿Hacen envíos?', site: true }
		]);

		const [integration] = await client`select provider, mode, public_config->>'simulator' as simulator, sealed_secrets from app.organization_integrations where organization_id = ${org!.id}`;
		expect(integration).toMatchObject({ provider: 'mercadopago', mode: 'sandbox', simulator: 'true' });
		expect(integration!.sealed_secrets).not.toContain('dev-webhook-secret');
		expect(await client`select action, metadata from app.audit_events where organization_id = ${org!.id}`).toEqual([
			{ action: 'organization.pack_loaded', metadata: { pack: pack.slug, hosts: pack.hosts } }
		]);

		expect(await snapshot(neighbour.id)).toEqual(before);
	});

	it('skips hosts another organization already uses, binds the next one as primary and leaves the other organization alone', async () => {
		const pack = samplePack();
		pack.hosts = [neighbour.host, ...pack.hosts];
		const before = await snapshot(neighbour.id);

		const result = await loadClientPack(handle, pack, fakeServices().services);

		expect(result.primaryHost).toBe(pack.hosts[1]);
		expect(result.hosts).toEqual(pack.hosts.slice(1));
		const domains = await client`select hostname, is_primary from app.organization_domains where organization_id = ${result.organizationId} order by hostname`;
		expect(domains).toEqual([
			{ hostname: pack.hosts[1], is_primary: true },
			{ hostname: pack.hosts[2], is_primary: false }
		]);
		expect(await snapshot(neighbour.id)).toEqual(before);
	});

	it('refuses when every host is taken, and writes nothing', async () => {
		const pack = samplePack({ hosts: [neighbour.host] });
		const before = await snapshot(neighbour.id);

		expect(await refusal(loadClientPack(handle, pack, fakeServices().services))).toBe(
			`Every host of ${pack.slug} is already bound to another organization: ${neighbour.host}. Pass --host <hostname> with a free one.`
		);
		expect(await organizationBySlug(pack.slug)).toBeUndefined();
		expect(await snapshot(neighbour.id)).toEqual(before);
	});

	it('leaves an existing organization as it is without update, and reports its primary host', async () => {
		const pack = samplePack();
		const first = await loadClientPack(handle, pack, fakeServices().services);
		const before = await snapshot(first.organizationId);
		const changed = { ...pack, name: 'Otro nombre', blocks: [{ key: 'brand' as const, content: { logo: null, logoAlt: 'Otro', tagline: 'Otro.' } }] };

		const { services, uploads } = fakeServices();
		const result = await loadClientPack(handle, changed, services);

		expect(result).toEqual({ outcome: 'exists', organizationId: first.organizationId, primaryHost: pack.hosts[0], hosts: pack.hosts, createdUsers: [], changes: [] });
		expect(uploads).toEqual([]);
		expect(await snapshot(first.organizationId)).toEqual(before);
	});

	it('with update, publishes changed content as new versions and keeps the catalog, campaign, approvals, hosts and members', async () => {
		const pack = samplePack();
		const first = await loadClientPack(handle, pack, fakeServices().services);
		const before = await snapshot(first.organizationId);
		const neighbourBefore = await snapshot(neighbour.id);
		const next: ClientPack = {
			...pack,
			name: 'Taller de Prueba Renovado',
			hosts: ['ignored-on-update.test'],
			settings: { ...pack.settings, contact: { ...pack.settings.contact, city: 'Córdoba, Córdoba' }, legal: { termsVersion: 'v2', privacyVersion: 'v1' } },
			theme: { ...pack.theme, radius: 12 },
			blocks: [
				pack.blocks[0]!,
				{ key: 'home', content: { heroTitle: 'Bienvenidos de nuevo', heroLead: 'Un taller de prueba para el cargador.' } },
				{ key: 'legal.terms', content: { version: 'v2', sections: [{ title: 'Borrador', body: 'Términos de prueba, segunda versión.' }] } },
				{ key: 'seo', content: { title: 'Taller de Prueba', description: 'Un taller de prueba.' } }
			],
			products: [...pack.products, { slug: 'nuevo', name: 'Producto nuevo', description: 'No se crea al actualizar.', kind: 'physical', priceMinor: 100, sku: 'TP-NUEVO' }]
		};

		const { services, uploads } = fakeServices();
		const result = await loadClientPack(handle, next, services, { update: true });

		expect(result).toEqual({
			outcome: 'updated',
			organizationId: first.organizationId,
			primaryHost: pack.hosts[0],
			hosts: pack.hosts,
			createdUsers: [],
			changes: ['name', 'settings', 'theme', 'block home', 'block legal.terms', 'block seo']
		});
		const org = await organizationBySlug(pack.slug);
		expect(org!.name).toBe('Taller de Prueba Renovado');
		expect(org!.settings).toEqual(next.settings);
		const themes = await client`select version, is_active, tokens->>'radius' as radius from app.organization_themes where organization_id = ${first.organizationId} order by version`;
		expect(themes).toEqual([
			{ version: 1, is_active: false, radius: null },
			{ version: 2, is_active: true, radius: '12' }
		]);
		const blocks = await client`select key, version from app.cms_blocks where organization_id = ${first.organizationId} order by key`;
		expect(blocks).toEqual([
			{ key: 'brand', version: 1 },
			{ key: 'home', version: 2 },
			{ key: 'legal.terms', version: 2 },
			{ key: 'seo', version: 1 }
		]);
		const revisions = await client`select key, version from app.cms_block_revisions where organization_id = ${first.organizationId} order by key, version`;
		expect(revisions).toEqual([
			{ key: 'brand', version: 1 },
			{ key: 'home', version: 1 },
			{ key: 'home', version: 2 },
			{ key: 'legal.terms', version: 1 },
			{ key: 'legal.terms', version: 2 },
			{ key: 'seo', version: 1 }
		]);
		expect(uploads).toEqual([]);

		const after = await snapshot(first.organizationId);
		for (const table of ['organization_domains', 'organization_members', 'organization_integrations', 'products', 'product_variants', 'product_assets', 'offers', 'offer_items', 'campaigns', 'campaign_approvals', 'campaign_rule_versions', 'prizes', 'campaign_faqs'] as const) {
			expect(after.tables[table], table).toEqual(before.tables[table]);
		}
		expect(await client`select action, metadata from app.audit_events where organization_id = ${first.organizationId} order by created_at`).toEqual([
			{ action: 'organization.pack_loaded', metadata: { pack: pack.slug, hosts: pack.hosts } },
			{ action: 'organization.pack_updated', metadata: { pack: pack.slug, changes: result.changes } }
		]);
		expect(await snapshot(neighbour.id)).toEqual(neighbourBefore);
	});

	it('with update and nothing changed, writes nothing', async () => {
		const pack = samplePack();
		const first = await loadClientPack(handle, pack, fakeServices().services);
		const before = await snapshot(first.organizationId);

		const result = await loadClientPack(handle, pack, fakeServices().services, { update: true });

		expect(result).toMatchObject({ outcome: 'updated', changes: [] });
		expect(await snapshot(first.organizationId)).toEqual(before);
	});

	it('with update, refuses a different legal text under the version buyers already accepted, and writes nothing', async () => {
		const pack = samplePack();
		const first = await loadClientPack(handle, pack, fakeServices().services);
		const before = await snapshot(first.organizationId);
		const next = { ...pack, name: 'Cambio que no se guarda', blocks: [{ key: 'legal.terms' as const, content: { version: 'v1', sections: [{ title: 'Borrador', body: 'Otro texto, misma versión.' }] } }] };

		expect(await refusal(loadClientPack(handle, next, fakeServices().services, { update: true }))).toBe(
			'legal.terms: publish the new text with a new version; buyers already accepted version v1.'
		);
		expect(await snapshot(first.organizationId)).toEqual(before);
	});

	it('without a payment simulator, connects no payment account', async () => {
		const pack = samplePack();
		const result = await loadClientPack(handle, pack, fakeServices({ simulator: false }).services);
		expect(await client`select id from app.organization_integrations where organization_id = ${result.organizationId}`).toEqual([]);
	});

	it('refuses an invalid pack before writing anything', async () => {
		const pack = samplePack({ blocks: [{ key: 'brand', content: { logo: null, logoAlt: '', tagline: 'x' } }] });

		expect(await refusal(loadClientPack(handle, pack, fakeServices().services))).toBe(`Invalid client pack ${pack.slug}:\n  block brand: logoAlt: Too small: expected string to have >=1 characters`);
		expect(await organizationBySlug(pack.slug)).toBeUndefined();
	});
});

describe('loadClientPack with update and catalog', () => {
	const pdf = (text: string) => new TextEncoder().encode(`%PDF-1.4\n% ${text}\n%%EOF\n`);

	/** A product-files bucket in memory, for the files an update replaces like `pnpm db:product-file`. */
	function memoryStorage() {
		const objects = new Map<string, Uint8Array>();
		const calls: string[] = [];
		const storage = {
			async upload(path: string, bytes: Uint8Array, contentType: string) {
				calls.push(`upload ${path} ${contentType}`);
				objects.set(path, bytes);
			},
			exists: async (path: string) => objects.has(path),
			async remove(paths: string[]) {
				calls.push(`remove ${paths.join(',')}`);
				for (const path of paths) objects.delete(path);
			}
		};
		return { storage, objects, calls };
	}

	it('creates missing products and updates existing ones by slug, never deleting products or variants nor touching stock, suggestions or campaigns', async () => {
		const pack = samplePack();
		const first = await loadClientPack(handle, pack, fakeServices().services);
		const before = await snapshot(first.organizationId);
		const neighbourBefore = await snapshot(neighbour.id);
		const [manual, remera] = pack.products as [ClientPack['products'][number], ClientPack['products'][number]];
		// Without the manual: a product left out of the pack is kept, never deleted. Its pitch and chances go with it.
		const { campaign: _campaign, pitches: _pitches, ...rest } = pack;
		const next: ClientPack = {
			...rest,
			products: [
				{ ...remera, name: 'Remera renovada', priceMinor: 4_800_000, imageUrl: '/tenants/prueba/remera.jpg', variants: [{ sku: 'TP-REMERA-S', name: 'Talle S', stock: 99 }, { sku: 'TP-REMERA-XL', name: 'Talle XL', stock: 3 }] },
				{ slug: 'gorra', name: 'Gorra de prueba', description: 'Gorra bordada.', kind: 'physical', priceMinor: 2_000_000, sku: 'TP-GORRA', stock: 7 }
			]
		};

		const { services, uploads } = fakeServices();
		const result = await loadClientPack(handle, next, services, { update: true, catalog: true });

		expect(result).toMatchObject({ outcome: 'updated', changes: ['product remera', 'product gorra added'] });
		const products = await client`select slug, name, status, position, image_url from app.products where organization_id = ${first.organizationId} order by slug`;
		expect(products).toEqual([
			{ slug: 'gorra', name: 'Gorra de prueba', status: 'active', position: 1, image_url: null },
			{ slug: 'manual', name: manual.name, status: 'active', position: 0, image_url: null },
			{ slug: 'remera', name: 'Remera renovada', status: 'active', position: 0, image_url: '/tenants/prueba/remera.jpg' }
		]);
		const variants = await client`
			select p.slug, v.sku, v.name, v.price_minor::int as price_minor, v.stock from app.product_variants v join app.products p on p.id = v.product_id
			where v.organization_id = ${first.organizationId} order by v.sku`;
		expect(variants).toEqual([
			{ slug: 'gorra', sku: 'TP-GORRA', name: 'Gorra de prueba', price_minor: 2_000_000, stock: 7 },
			{ slug: 'manual', sku: 'TP-MANUAL', name: 'Manual de prueba', price_minor: 5_000_000, stock: null },
			// Stock is the shop's live state: an existing variant keeps it; a new one starts with the pack's.
			{ slug: 'remera', sku: 'TP-REMERA-M', name: 'Talle M', price_minor: 4_800_000, stock: 5 },
			{ slug: 'remera', sku: 'TP-REMERA-S', name: 'Talle S', price_minor: 4_800_000, stock: 5 },
			{ slug: 'remera', sku: 'TP-REMERA-XL', name: 'Talle XL', price_minor: 4_800_000, stock: 3 }
		]);
		expect(uploads).toEqual([]);

		const after = await snapshot(first.organizationId);
		for (const table of ['organization_domains', 'organization_members', 'organization_integrations', 'product_assets', 'offers', 'offer_items', 'campaigns', 'campaign_approvals', 'campaign_rule_versions', 'prizes', 'campaign_faqs', 'cms_blocks'] as const) {
			expect(after.tables[table], table).toEqual(before.tables[table]);
		}
		expect(await client`select action, metadata from app.audit_events where organization_id = ${first.organizationId} order by created_at`).toEqual([
			{ action: 'organization.pack_loaded', metadata: { pack: pack.slug, hosts: pack.hosts } },
			{ action: 'organization.pack_updated', metadata: { pack: pack.slug, changes: result.changes } }
		]);
		expect(await snapshot(neighbour.id)).toEqual(neighbourBefore);

		// Running it again changes nothing.
		const again = await loadClientPack(handle, next, fakeServices().services, { update: true, catalog: true });
		expect(again.changes).toEqual([]);
		expect(await snapshot(first.organizationId)).toEqual(after);
	});

	it('replaces the file of an existing product with the declared one, keeping its asset row, and then leaves it alone', async () => {
		const pack = samplePack();
		const first = await loadClientPack(handle, pack, fakeServices().services);
		const [sample] = await client<{ id: string; storage_path: string }[]>`select id, storage_path from app.product_assets where organization_id = ${first.organizationId}`;
		const bytes = pdf('the real manual');
		const sha256 = createHash('sha256').update(bytes).digest('hex');
		const next: ClientPack = { ...pack, files: { manual: { filename: 'Manual-real.pdf', sha256, contentType: 'application/pdf' } } };
		const { storage, objects, calls } = memoryStorage();
		objects.set(sample!.storage_path, pdf('sample'));
		const services: ClientPackServices = {
			...fakeServices().services,
			readDeclaredFile: async () => ({ bytes, source: 'local', location: 'clients/prueba/files/x' }),
			productFileStorage: storage
		};
		const options = { update: true, catalog: true, productFileOptions: { sleep: async (ms: number) => void calls.push(`wait ${ms}`) } };

		const result = await loadClientPack(handle, next, services, options);

		expect(result.changes).toEqual(['file manual replaced']);
		const path = `${first.organizationId}/${(await client`select id from app.products where organization_id = ${first.organizationId} and slug = 'manual'`)[0]!.id}/${sha256.slice(0, 16)}.pdf`;
		expect(await client`select id, storage_path, filename, size_bytes from app.product_assets where organization_id = ${first.organizationId}`).toEqual([
			{ id: sample!.id, storage_path: path, filename: 'Manual-real.pdf', size_bytes: bytes.byteLength }
		]);
		expect(calls).toEqual([`upload ${path} application/pdf`, 'wait 65000', `remove ${sample!.storage_path}`]);
		expect(objects.get(path)).toEqual(bytes);

		// The product already has the declared file: nothing is read, uploaded or changed.
		const unread: ClientPackServices = { ...services, readDeclaredFile: async () => null };
		expect((await loadClientPack(handle, next, unread, { ...options, realFilesOnly: true })).changes).toEqual([]);
		expect(calls).toHaveLength(3);
	});

	// Owner feedback 2026-11-11b, S2: the ZIP becomes its images, each with its own download link.
	it('makes an existing product deliver the list of files, reusing its file row so sent links work, and then leaves it alone', async () => {
		const pack = samplePack();
		const first = await loadClientPack(handle, pack, fakeServices().services);
		const [sample] = await client<{ id: string; storage_path: string }[]>`select id, storage_path from app.product_assets where organization_id = ${first.organizationId}`;
		const png = (text: string) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new TextEncoder().encode(text)]);
		const images = [png('con borde'), png('sin borde'), png('fondo')];
		const seeds = images.map((bytes, index) => ({ filename: `Imagen-${index + 1}.png`, sha256: createHash('sha256').update(bytes).digest('hex'), contentType: 'image/png' as const }));
		const next: ClientPack = { ...pack, files: { manual: seeds } };
		const { storage, objects, calls } = memoryStorage();
		objects.set(sample!.storage_path, pdf('sample'));
		const services: ClientPackServices = {
			...fakeServices().services,
			readDeclaredFile: async (_slug, file) => ({ bytes: images[seeds.findIndex((entry) => entry.sha256 === file.sha256)]!, source: 'local', location: `clients/prueba/files/${file.filename}` }),
			productFileStorage: storage
		};
		const options = { update: true, catalog: true, productFileOptions: { sleep: async (ms: number) => void calls.push(`wait ${ms}`) } };

		const result = await loadClientPack(handle, next, services, options);

		expect(result.changes).toEqual(['files manual: 1 replaced, 2 added']);
		expect(result.files?.map((file) => file.filename)).toEqual(['Imagen-1.png', 'Imagen-2.png', 'Imagen-3.png']);
		const rows = await client<{ id: string; filename: string; position: number }[]>`
			select id, filename, position from app.product_assets where organization_id = ${first.organizationId} order by position`;
		expect(rows.map(({ filename, position }) => ({ filename, position }))).toEqual(seeds.map(({ filename }, position) => ({ filename, position })));
		expect(rows[0]!.id).toBe(sample!.id);
		expect(calls.slice(-2)).toEqual(['wait 65000', `remove ${sample!.storage_path}`]);

		// The product already has the declared files: nothing is read, uploaded or changed.
		const unread: ClientPackServices = { ...services, readDeclaredFile: async () => null };
		const callsBefore = calls.length;
		expect((await loadClientPack(handle, next, unread, { ...options, realFilesOnly: true })).changes).toEqual([]);
		expect(calls).toHaveLength(callsBefore);
	});

	it('creates a product the pack marks as draft out of the shop, and never changes the status of an existing product', async () => {
		const pack = samplePack();
		const first = await loadClientPack(handle, pack, fakeServices().services);
		const draft = { slug: 'calco-digital', name: 'Calco digital', description: 'Arte para imprimir.', kind: 'digital' as const, priceMinor: 700_000, sku: 'TP-CALCO-DIGITAL', asset: true, status: 'draft' as const };
		const next: ClientPack = { ...pack, products: [...pack.products, draft] };

		expect((await loadClientPack(handle, next, fakeServices().services, { update: true, catalog: true })).changes).toEqual(['product calco-digital added']);
		const status = async (slug: string) => (await client<{ status: string }[]>`select status from app.products where organization_id = ${first.organizationId} and slug = ${slug}`)[0]!.status;
		expect(await status('calco-digital')).toBe('draft');
		expect(await status('manual')).toBe('active');

		// Once the shop activates it, a later update leaves the status alone, and so does a pack without status for an archived product.
		await client`update app.products set status = 'active' where organization_id = ${first.organizationId} and slug = 'calco-digital'`;
		await client`update app.products set status = 'archived' where organization_id = ${first.organizationId} and slug = 'manual'`;
		expect((await loadClientPack(handle, next, fakeServices().services, { update: true, catalog: true })).changes).toEqual([]);
		expect(await status('calco-digital')).toBe('active');
		expect(await status('manual')).toBe('archived');
	});

	it('with --campaign, adds the pack campaign as a draft when the organization has none with its slug, and never changes it afterwards', async () => {
		const pack = samplePack({ campaign: undefined });
		const first = await loadClientPack(handle, pack, fakeServices().services);
		const campaign = { ...samplePack().campaign!, slug: 'wave', title: 'Honda Wave', isDemo: false, chancesPerUnit: { manual: 15 } };
		const next: ClientPack = { ...pack, campaign };

		// Without --campaign an update leaves campaigns alone, as before.
		expect((await loadClientPack(handle, next, fakeServices().services, { update: true })).changes).toEqual([]);
		expect(await client`select id from app.campaigns where organization_id = ${first.organizationId}`).toEqual([]);

		const result = await loadClientPack(handle, next, fakeServices().services, { update: true, campaign: true });
		expect(result.changes).toEqual(['campaign wave added']);
		const [row] = await client<{ id: string; status: string; is_demo: boolean; title: string }[]>`select id, status, is_demo, title from app.campaigns where organization_id = ${first.organizationId}`;
		expect(row).toMatchObject({ status: 'draft', is_demo: false, title: 'Honda Wave' });
		// Never an approval: both are pending until a person records them (ADR 0015).
		expect(await client`select kind, status from app.campaign_approvals where campaign_id = ${row!.id} order by kind`).toEqual([
			{ kind: 'legal', status: 'pending' },
			{ kind: 'psp', status: 'pending' }
		]);
		const [manualVariant] = await client<{ id: string }[]>`select v.id from app.product_variants v join app.products p on p.id = v.product_id where p.organization_id = ${first.organizationId} and p.slug = 'manual'`;
		const [rules] = await client<{ status: string; entry_rule: { entriesPerUnit: Record<string, number> } }[]>`select status, entry_rule from app.campaign_rule_versions where campaign_id = ${row!.id}`;
		expect(rules).toMatchObject({ status: 'draft', entry_rule: { entriesPerUnit: { [manualVariant!.id]: 15 } } });
		expect(await client`select title from app.prizes where campaign_id = ${row!.id}`).toEqual([{ title: '$100.000 en efectivo' }]);

		// Loading it again, even with other content, changes nothing: the campaign is edited in the admin.
		const after = await snapshot(first.organizationId);
		const again = await loadClientPack(handle, { ...next, campaign: { ...campaign, title: 'Otro título' } }, fakeServices().services, { update: true, campaign: true });
		expect(again.changes).toEqual([]);
		expect(await snapshot(first.organizationId)).toEqual(after);
	});

	it('with --campaign, refuses a campaign whose chances name a product the organization does not have, and writes nothing', async () => {
		const pack = samplePack({ campaign: undefined });
		const first = await loadClientPack(handle, pack, fakeServices().services);
		const before = await snapshot(first.organizationId);
		const campaign = { ...samplePack().campaign!, slug: 'wave', isDemo: false, chancesPerUnit: { gorra: 3 } };
		const products = [...pack.products, { slug: 'gorra', name: 'Gorra', description: 'Gorra bordada.', kind: 'physical' as const, priceMinor: 2_000_000, sku: 'TP-GORRA', stock: 7 }];
		await expect(loadClientPack(handle, { ...pack, products, campaign }, fakeServices().services, { update: true, campaign: true })).rejects.toThrow(
			'campaign.chancesPerUnit: gorra is not a product of this organization yet; load the catalog first (--catalog).'
		);
		expect(await snapshot(first.organizationId)).toEqual(before);
	});

	it('refuses to change the kind of an existing product, and writes nothing', async () => {
		const pack = samplePack();
		const first = await loadClientPack(handle, pack, fakeServices().services);
		const before = await snapshot(first.organizationId);
		const { campaign: _campaign, pitches: _pitches, ...rest } = pack;
		const next: ClientPack = { ...rest, products: [pack.products[0]!, { ...pack.products[1]!, kind: 'digital' }] };

		expect(await refusal(loadClientPack(handle, next, fakeServices().services, { update: true, catalog: true }))).toBe(
			'products.remera: it is a physical product; a product never changes kind (create another product instead).'
		);
		expect(await snapshot(first.organizationId)).toEqual(before);
	});
});

describe('validateClientPack', () => {
	it('lists every problem of a pack', () => {
		const pack = samplePack();
		pack.slug = 'Bad Slug';
		pack.hosts = [];
		pack.theme = { radius: -4 } as ClientPack['theme'];
		pack.pitches = { missing: 'x' };
		pack.campaign = { ...pack.campaign!, chancesPerUnit: { manual: 0, ghost: 3 } };
		pack.products = [...pack.products, { ...pack.products[0]! }];

		expect(validateClientPack(pack)).toEqual([
			'slug: use lowercase letters, digits and dashes',
			'hosts: list at least one hostname',
			expect.stringMatching(/^theme: radius: /),
			'products: slug manual is repeated',
			'pitches: no product missing',
			'campaign.chancesPerUnit: manual must be a whole number of at least 1',
			'campaign.chancesPerUnit: no product ghost'
		]);
	});

	it('accepts the packs the seed loads', () => {
		expect(validateClientPack(tallerDemoPack)).toEqual([]);
		expect(validateClientPack(pistaSurPack)).toEqual([]);
	});

	// Client packs exist only in the private repository (clients/, never published).
	const clientsDir = resolve(import.meta.dirname, '../../../clients');
	const clients = existsSync(clientsDir) ? readdirSync(clientsDir).filter((name) => existsSync(resolve(clientsDir, name, 'pack.ts'))) : [];
	it.skipIf(clients.length === 0)('accepts every private client pack', async () => {
		for (const name of clients) {
			const module = (await import(pathToFileURL(resolve(clientsDir, name, 'pack.ts')).href)) as { pack: ClientPack };
			expect(validateClientPack(module.pack), name).toEqual([]);
			expect(module.pack.slug, name).toBe(name);
		}
	});

	// Owner 2026-11-10: a client's production starts from its pack, with no test content and no demo campaign.
	it.skipIf(clients.length === 0)('keeps test content and demo campaigns out of every private client pack', async () => {
		for (const name of clients) {
			const module = (await import(pathToFileURL(resolve(clientsDir, name, 'pack.ts')).href)) as { pack: ClientPack };
			expect(JSON.stringify(module.pack), name).not.toMatch(/e2e-\d|lorem|example\.com|Taller Demo/i);
			expect(module.pack.campaign?.isDemo ?? false, name).toBe(false);
		}
	});
});
