import { randomBytes, randomUUID } from 'node:crypto';
import { and, eq, schema as s, sql } from '@sortea/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminHeaders, createTenant, createTestContext, headers, placeOrder, type TenantFixture, type TestContext } from './helpers';

let ctx: TestContext;
let tenant: TenantFixture;
let other: TenantFixture;
const adminId = randomUUID();

const jpeg = (seed = randomBytes(16)) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), seed]);
const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

const seo = { title: 'Taller de motos', description: 'Restauraciones y service en Arrecifes.', image: null };
const terms = (version: string) => ({ version, sections: [{ title: 'Compra', body: 'La compra se confirma cuando Mercado Pago aprueba el pago.' }] });

async function call(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown, auth?: Record<string, string>) {
	return ctx.app.inject({ method, url, headers: auth ?? (await adminHeaders(ctx, tenant, adminId)), payload: payload as Record<string, unknown> | undefined });
}

async function upload(bytes: Buffer, filename = 'foto.jpg', target = tenant, userId: string = adminId) {
	return ctx.app.inject({
		method: 'POST',
		url: `/admin/cms/media?filename=${encodeURIComponent(filename)}`,
		headers: { ...(await adminHeaders(ctx, target, userId)), 'content-type': 'application/octet-stream' },
		payload: bytes
	});
}

async function site(target = tenant) {
	const response = await ctx.app.inject({ method: 'GET', url: '/public/site', headers: headers(target) });
	return response.json() as { content: Record<string, Record<string, unknown>>; faqs: { id: string; question: string }[]; legal: { termsVersion: string; privacyVersion: string } };
}

async function auditActions(target = tenant) {
	const rows = await ctx.db.withTenant(target.id, (tx) => tx.select({ action: s.auditEvents.action }).from(s.auditEvents));
	return rows.map((row) => row.action);
}

beforeAll(async () => {
	ctx = await createTestContext();
	tenant = await createTenant(ctx, 'cms');
	other = await createTenant(ctx, 'cms-other');
	await ctx.db.withPlatform((db) => db.insert(s.organizationMembers).values({ organizationId: tenant.id, userId: adminId, email: `admin@${tenant.host}`, role: 'org_admin' }));
});
afterAll(() => ctx.close());

describe('drafts and publishing (FR-CMS-04)', () => {
	it('keeps a draft private until it is published', async () => {
		const saved = await call('PUT', '/admin/cms/blocks/seo', { content: seo });
		expect(saved.statusCode, saved.body).toBe(200);
		expect(saved.json()).toMatchObject({ key: 'seo', draft: seo, published: null, version: 1 });
		expect((await site()).content.seo).toBeUndefined();

		const published = await call('POST', '/admin/cms/blocks/seo/publish');
		expect(published.statusCode, published.body).toBe(200);
		expect(published.json()).toMatchObject({ key: 'seo', draft: null, published: seo, version: 1 });
		expect((await site()).content.seo).toEqual(seo);
		expect((await site(other)).content.seo).toBeUndefined();
	});

	it('bumps the version and keeps every published revision', async () => {
		await call('PUT', '/admin/cms/blocks/seo', { content: { ...seo, title: 'Garage de motos' } });
		expect((await site()).content.seo).toEqual(seo);
		const published = await call('POST', '/admin/cms/blocks/seo/publish');
		expect(published.json()).toMatchObject({ version: 2, published: { title: 'Garage de motos' } });

		const revisions = await call('GET', '/admin/cms/blocks/seo/revisions');
		expect(revisions.json().revisions.map((revision: { version: number; content: { title: string } }) => [revision.version, revision.content.title])).toEqual([
			[2, 'Garage de motos'],
			[1, 'Taller de motos']
		]);
		expect((await auditActions()).filter((action) => action === 'cms.published')).toHaveLength(2);
		const overview = (await call('GET', '/admin/cms')).json();
		expect(overview.blocks.find((block: { key: string }) => block.key === 'seo').revisions.map((revision: { version: number }) => revision.version)).toEqual([2, 1]);
	});

	it('discards a draft without touching what is published', async () => {
		await call('PUT', '/admin/cms/blocks/seo', { content: { ...seo, title: 'Borrador descartado' } });
		const discarded = await call('DELETE', '/admin/cms/blocks/seo/draft');
		expect(discarded.statusCode).toBe(200);
		expect(discarded.json()).toMatchObject({ draft: null, version: 2, published: { title: 'Garage de motos' } });
		expect((await call('POST', '/admin/cms/blocks/seo/publish')).json().error.code).toBe('nothing_to_publish');
	});

	it('rejects invalid content and unknown blocks without saving anything', async () => {
		const invalid = await call('PUT', '/admin/cms/blocks/seo', { content: { ...seo, title: 'x'.repeat(71) } });
		expect(invalid.statusCode).toBe(400);
		expect(invalid.json().error.code).toBe('invalid_content');
		expect((await call('PUT', '/admin/cms/blocks/footer', { content: {} })).statusCode).toBe(404);
		const overview = await call('GET', '/admin/cms');
		expect(overview.json().blocks.find((block: { key: string }) => block.key === 'seo')).toMatchObject({ draft: null, version: 2 });
	});

	it('lets only owners and admins edit the site', async () => {
		const asOperator = await adminHeaders(ctx, tenant, tenant.operatorId);
		expect((await call('GET', '/admin/cms', undefined, asOperator)).statusCode).toBe(403);
		expect((await call('PUT', '/admin/cms/blocks/seo', { content: seo }, asOperator)).statusCode).toBe(403);
		expect((await call('GET', '/admin/cms', undefined, await adminHeaders(ctx, tenant))).statusCode).toBe(200);
	});
});

describe('site media', () => {
	let ref: string;
	let mediaId: string;

	it('stores images by content under the organization and serves them from the public bucket', async () => {
		const bytes = jpeg();
		const created = await upload(bytes, 'taller.jpg');
		expect(created.statusCode, created.body).toBe(201);
		const media = created.json();
		expect(media).toMatchObject({ filename: 'taller.jpg', contentType: 'image/jpeg', sizeBytes: bytes.length, inUse: false });
		expect(media.ref).toMatch(new RegExp(`^media:${tenant.id}/[0-9a-f]{64}\\.jpg$`));
		expect(media.url).toBe(`https://media.test/${media.ref.slice('media:'.length)}`);
		expect(ctx.media.objects.get(media.ref.slice('media:'.length))).toMatchObject({ contentType: 'image/jpeg' });
		ref = media.ref;
		mediaId = media.id;

		const again = await upload(bytes, 'otra.jpg');
		expect(again.statusCode).toBe(200);
		expect(again.json().id).toBe(mediaId);
		expect((await auditActions()).filter((action) => action === 'cms.media_uploaded')).toHaveLength(1);
	});

	it('refuses anything that is not a JPEG, PNG or WebP, whatever its name says', async () => {
		const objects = ctx.media.objects.size;
		const response = await upload(svg, 'logo.jpg');
		expect(response.statusCode).toBe(415);
		expect(response.json().error.code).toBe('unsupported_image');
		expect((await upload(Buffer.alloc(0), 'vacio.jpg')).statusCode).toBe(415);
		expect(ctx.media.objects.size).toBe(objects);
	});

	it('refuses images over 2 MB', async () => {
		const response = await upload(jpeg(randomBytes(2 * 1024 * 1024)), 'grande.jpg');
		expect(response.statusCode).toBe(413);
	});

	it('resolves uploaded images in the public site and protects them while in use', async () => {
		const saved = await call('PUT', '/admin/cms/blocks/seo', { content: { ...seo, image: ref } });
		expect(saved.statusCode, saved.body).toBe(200);
		await call('POST', '/admin/cms/blocks/seo/publish');
		expect((await site()).content.seo!.image).toBe(`https://media.test/${ref.slice('media:'.length)}`);

		const removal = await call('DELETE', `/admin/cms/media/${mediaId}`);
		expect(removal.statusCode).toBe(409);
		expect(removal.json().error.code).toBe('media_in_use');
		expect(ctx.media.objects.has(ref.slice('media:'.length))).toBe(true);
	});

	it('does not accept images of another organization', async () => {
		const foreign = (await upload(jpeg(), 'ajena.jpg', other, other.ownerId)).json().ref as string;
		const response = await call('PUT', '/admin/cms/blocks/brand', { content: { logo: foreign, logoAlt: 'Logo', tagline: 'Hola' } });
		expect(response.statusCode).toBe(400);
		expect(response.json().error.code).toBe('unknown_media');
		const list = await call('GET', '/admin/cms');
		expect(list.json().media.map((media: { ref: string }) => media.ref)).not.toContain(foreign);
	});

	it('deletes unused images from the bucket', async () => {
		const unused = (await upload(jpeg(), 'sobra.jpg')).json();
		const removal = await call('DELETE', `/admin/cms/media/${unused.id}`);
		expect(removal.statusCode).toBe(200);
		expect(ctx.media.objects.has(unused.ref.slice('media:'.length))).toBe(false);
		expect((await call('DELETE', `/admin/cms/media/${unused.id}`)).statusCode).toBe(404);
		expect((await call('DELETE', `/admin/cms/media/${unused.id}`, undefined, await adminHeaders(ctx, other))).statusCode).toBe(404);
	});
});

describe('restorations gallery', () => {
	const gallery = {
		enabled: true,
		title: 'Restauraciones',
		lead: 'Motos con historia que vuelven a la ruta.',
		note: 'Fotos de ejemplo de motos clásicas, de Wikimedia Commons; pronto, los trabajos del taller.',
		items: [
			{
				image: '/tenants/motogarage/restauraciones/honda-cb750.jpg',
				alt: 'Honda CB750 Four restaurada',
				title: 'Honda CB750 Four',
				body: 'La moto que cambió todo.',
				credit: { author: 'Jane Doe', license: 'CC BY-SA 4.0', sourceUrl: 'https://commons.wikimedia.org/wiki/File:Honda_CB750.jpg' }
			}
		]
	};

	it('saves, publishes and serves the gallery with uploaded photos resolved', async () => {
		const uploaded = (await upload(jpeg(), 'cafe-racer.jpg')).json().ref as string;
		const content = { ...gallery, items: [...gallery.items, { image: uploaded, alt: 'Café racer en el taller', title: 'Café racer' }] };
		const saved = await call('PUT', '/admin/cms/blocks/gallery', { content });
		expect(saved.statusCode, saved.body).toBe(200);
		expect((await site()).content.gallery).toBeUndefined();

		const published = await call('POST', '/admin/cms/blocks/gallery/publish');
		expect(published.statusCode, published.body).toBe(200);
		expect(published.json()).toMatchObject({ key: 'gallery', version: 1, draft: null });
		const served = (await site()).content.gallery as typeof gallery;
		expect(served).toMatchObject({ enabled: true, note: gallery.note, items: [gallery.items[0], { title: 'Café racer', credit: null }] });
		expect(served.items[1]!.image).toBe(`https://media.test/${uploaded.slice('media:'.length)}`);
		expect((await site(other)).content.gallery).toBeUndefined();
	});

	it('refuses photos without a description or credits outside https', async () => {
		const [photo] = gallery.items;
		const noAlt = await call('PUT', '/admin/cms/blocks/gallery', { content: { ...gallery, items: [{ ...photo, alt: '' }] } });
		expect(noAlt.statusCode).toBe(400);
		expect(noAlt.json().error.code).toBe('invalid_content');
		const insecure = await call('PUT', '/admin/cms/blocks/gallery', { content: { ...gallery, items: [{ ...photo, credit: { ...photo!.credit, sourceUrl: 'http://example.test/x' } }] } });
		expect(insecure.statusCode).toBe(400);
		const overview = await call('GET', '/admin/cms');
		expect(overview.json().blocks.find((block: { key: string }) => block.key === 'gallery')).toMatchObject({ draft: null, version: 1 });
	});
});

describe('legal texts', () => {
	it('publishes terms under a new version that checkout records from then on', async () => {
		await call('PUT', '/admin/cms/blocks/legal.terms', { content: terms('2026-11') });
		const published = await call('POST', '/admin/cms/blocks/legal.terms/publish');
		expect(published.statusCode, published.body).toBe(200);

		const view = await site();
		expect(view.legal.termsVersion).toBe('2026-11');
		expect(view.content['legal.terms']).toEqual(terms('2026-11'));

		const order = await placeOrder(ctx, tenant);
		const consents = await ctx.db.withTenant(tenant.id, (tx) =>
			tx
				.select({ purpose: s.contactConsents.purpose, version: s.contactConsents.policyVersion })
				.from(s.contactConsents)
				.innerJoin(s.orders, eq(s.orders.id, s.contactConsents.orderId))
				.where(and(eq(s.orders.reference, order.reference), eq(s.contactConsents.purpose, 'terms')))
		);
		expect(consents).toEqual([{ purpose: 'terms', version: '2026-11' }]);
	});

	it('records the version published by another API instance, even with this tenant cached', async () => {
		await placeOrder(ctx, tenant);
		await ctx.db.withPlatform((db) =>
			db
				.update(s.organizations)
				.set({ settings: sql`jsonb_set(${s.organizations.settings}, '{legal,privacyVersion}', '"2026-12"')` })
				.where(eq(s.organizations.id, tenant.id))
		);
		const order = await placeOrder(ctx, tenant);
		const [consent] = await ctx.db.withTenant(tenant.id, (tx) =>
			tx
				.select({ version: s.contactConsents.policyVersion })
				.from(s.contactConsents)
				.innerJoin(s.orders, eq(s.orders.id, s.contactConsents.orderId))
				.where(and(eq(s.orders.reference, order.reference), eq(s.contactConsents.purpose, 'privacy')))
		);
		expect(consent).toEqual({ version: '2026-12' });
		// The legal pages label their text with the same version checkout records.
		expect((await site()).legal).toMatchObject({ privacyVersion: '2026-12' });
	});

	it('refuses to bring back an earlier version label with different text, but restores the same text', async () => {
		await call('PUT', '/admin/cms/blocks/legal.privacy', { content: terms('p-1') });
		expect((await call('POST', '/admin/cms/blocks/legal.privacy/publish')).statusCode).toBe(200);
		await call('PUT', '/admin/cms/blocks/legal.privacy', { content: terms('p-2') });
		expect((await call('POST', '/admin/cms/blocks/legal.privacy/publish')).statusCode).toBe(200);

		await call('PUT', '/admin/cms/blocks/legal.privacy', { content: { ...terms('p-1'), sections: [{ title: 'Otra', body: 'Otro texto con una versión vieja.' }] } });
		const reused = await call('POST', '/admin/cms/blocks/legal.privacy/publish');
		expect(reused.statusCode).toBe(409);
		expect(reused.json().error.code).toBe('legal_version_used');
		expect((await site()).content['legal.privacy']).toEqual(terms('p-2'));

		await call('PUT', '/admin/cms/blocks/legal.privacy', { content: terms('p-1') });
		expect((await call('POST', '/admin/cms/blocks/legal.privacy/publish')).statusCode).toBe(200);
		expect((await site()).legal).toMatchObject({ privacyVersion: 'p-1' });
	});

	it('refuses to publish different text under the same version', async () => {
		await call('PUT', '/admin/cms/blocks/legal.terms', { content: { ...terms('2026-11'), sections: [{ title: 'Otra', body: 'Texto distinto con la misma versión.' }] } });
		const response = await call('POST', '/admin/cms/blocks/legal.terms/publish');
		expect(response.statusCode).toBe(409);
		expect(response.json().error.code).toBe('legal_version_unchanged');
		expect((await site()).content['legal.terms']).toEqual(terms('2026-11'));
	});
});

describe('FAQs', () => {
	it('manages the site FAQs in order', async () => {
		const second = await call('POST', '/admin/faqs', { question: '¿Hacen envíos?', answer: 'Sí, a todo el país.', position: 2 });
		const first = await call('POST', '/admin/faqs', { question: '¿Dónde están?', answer: 'En Arrecifes, Buenos Aires.', position: 1 });
		expect(second.statusCode, second.body).toBe(201);
		expect((await site()).faqs.map((faq) => faq.question)).toEqual(['¿Dónde están?', '¿Hacen envíos?']);
		expect((await site()).faqs.map((faq) => faq.id)).toEqual([first.json().id, second.json().id]);

		const edited = await call('PATCH', `/admin/faqs/${first.json().id}`, { answer: 'En Arrecifes, provincia de Buenos Aires.' });
		expect(edited.json()).toMatchObject({ answer: 'En Arrecifes, provincia de Buenos Aires.', campaignId: null });
		const empty = await call('PATCH', `/admin/faqs/${first.json().id}`, {});
		expect(empty.statusCode).toBe(400);
		expect(empty.json().error.code).toBe('invalid_request');
		expect((await call('DELETE', `/admin/faqs/${second.json().id}`)).statusCode).toBe(200);
		expect((await site()).faqs.map((faq) => faq.question)).toEqual(['¿Dónde están?']);
		expect((await call('PATCH', `/admin/faqs/${first.json().id}`, { answer: 'Ajena' }, await adminHeaders(ctx, other))).statusCode).toBe(404);
		expect(await auditActions()).toEqual(expect.arrayContaining(['faq.created', 'faq.updated', 'faq.deleted']));
	});

	it('adds FAQs to a campaign for those who manage campaigns', async () => {
		const created = await call('POST', '/admin/faqs', { campaignId: tenant.campaignId, question: '¿Cuándo es el sorteo?', answer: 'En la fecha publicada en las bases.' });
		expect(created.statusCode, created.body).toBe(201);
		const campaign = await ctx.app.inject({ method: 'GET', url: `/public/campaigns/${tenant.campaignSlug}`, headers: headers(tenant) });
		expect(campaign.json().faqs.map((faq: { question: string }) => faq.question)).toEqual(['¿Cuándo es el sorteo?']);
		expect((await site()).faqs.map((faq) => faq.question)).not.toContain('¿Cuándo es el sorteo?');

		const foreignCampaign = await call('POST', '/admin/faqs', { campaignId: other.campaignId, question: '¿Cuándo es el sorteo?', answer: 'Nunca, no es tuya.' });
		expect(foreignCampaign.statusCode).toBe(404);
		const list = await call('GET', `/admin/faqs?campaignId=${tenant.campaignId}`);
		expect(list.json().faqs).toHaveLength(1);
	});
});
