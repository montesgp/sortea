import { randomBytes, randomUUID } from 'node:crypto';
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
});
