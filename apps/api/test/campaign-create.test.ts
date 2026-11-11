import { randomUUID } from 'node:crypto';
import { and, eq, schema as s } from '@sortea/db';
import { sha256Hex } from '@sortea/domain/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminHeaders, createTenant, createTestContext, headers, type TenantFixture, type TestContext } from './helpers';

/**
 * S5 (owner feedback 2026-11-10): a campaign is created from the admin as a
 * draft, possibly without dates, with its products and chances, a first rules
 * version and its approvals pending. It opens only through the existing gate.
 */

let ctx: TestContext;
let tenant: TenantFixture;
let other: TenantFixture;
const platformAdmin = randomUUID();
let manualProductId: string;

const rules = '# Bases y condiciones\n\nTexto inicial de las bases de la campaña.';
const body = (overrides: Record<string, unknown> = {}) => ({
	title: 'Honda Wave 0 km',
	slug: 'honda-wave',
	subtitle: 'Tu moto nueva',
	summary: 'Sorteamos una Honda Wave 0 km entre quienes compran en la tienda.',
	seo: { title: 'Honda Wave 0 km', description: 'Participá por una Honda Wave 0 km.' },
	eligibility: { minAge: 18, residency: 'República Argentina' },
	rulesMarkdown: rules,
	...overrides
});

beforeAll(async () => {
	ctx = await createTestContext();
	tenant = await createTenant(ctx, 'newcamp');
	other = await createTenant(ctx, 'othercamp');
	await ctx.db.withPlatform((db) => db.insert(s.platformAdmins).values({ userId: platformAdmin, email: 'newcamp-platform@test' }).onConflictDoNothing());
	const [product] = await ctx.db.withTenant(tenant.id, (tx) => tx.select({ id: s.productVariants.productId }).from(s.productVariants).where(eq(s.productVariants.id, tenant.manualVariantId)));
	manualProductId = product!.id;
});
afterAll(() => ctx.close());

const create = async (payload: Record<string, unknown>, auth?: Record<string, string>, target: TenantFixture = tenant) =>
	ctx.app.inject({ method: 'POST', url: '/admin/campaigns', headers: auth ?? (await adminHeaders(ctx, target)), payload });

describe('creating a campaign from the admin (S5)', () => {
	let created: { id: string; [key: string]: unknown };

	it('creates a draft without dates, with chances, a first rules version and pending approvals', async () => {
		const response = await create(body({ chancesPerProduct: { [manualProductId]: 2 } }));
		expect(response.statusCode).toBe(201);
		created = response.json();
		expect(created).toMatchObject({
			slug: 'honda-wave',
			title: 'Honda Wave 0 km',
			subtitle: 'Tu moto nueva',
			status: 'draft',
			isDemo: false,
			timezone: 'America/Argentina/Buenos_Aires',
			opensAt: null,
			closesAt: null,
			drawAt: null,
			requiredApprovals: ['legal', 'psp'],
			gate: { allowed: false, missing: ['legal', 'psp'], rejected: [] },
			prizes: []
		});
		expect((created.approvals as { kind: string; status: string; decidedAt: string | null }[]).map((approval) => [approval.kind, approval.status, approval.decidedAt]).sort()).toEqual([
			['legal', 'pending', null],
			['psp', 'pending', null]
		]);
		expect(created.rules).toEqual([
			expect.objectContaining({
				version: 1,
				status: 'draft',
				bodyMarkdown: rules,
				eligibility: { minAge: 18, residency: 'República Argentina', excluded: [] },
				entryRule: { mode: 'per_unit', entriesPerUnit: { [tenant.manualVariantId]: 2 }, maxEntriesPerIdentity: null },
				contentHash: sha256Hex(rules),
				lockedAt: null
			})
		]);
		const [row] = await ctx.db.withTenant(tenant.id, (tx) => tx.select().from(s.campaigns).where(eq(s.campaigns.id, created.id)));
		expect(row).toMatchObject({ organizationId: tenant.id, seo: { title: 'Honda Wave 0 km', description: 'Participá por una Honda Wave 0 km.' } });
	});

	it('audits the creation', async () => {
		const events = await ctx.db.withTenant(tenant.id, (tx) =>
			tx.select().from(s.auditEvents).where(and(eq(s.auditEvents.action, 'campaign.created'), eq(s.auditEvents.targetId, created.id)))
		);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ actorType: 'admin', actorId: tenant.ownerId, targetType: 'campaign', metadata: { slug: 'honda-wave', dated: false } });
	});

	it('lists it and renders its detail, and it is neither public nor open', async () => {
		const auth = await adminHeaders(ctx, tenant);
		const list = (await ctx.app.inject({ method: 'GET', url: '/admin/campaigns', headers: auth })).json();
		expect(list.campaigns.find((campaign: { id: string }) => campaign.id === created.id)).toMatchObject({ status: 'draft', opensAt: null, closesAt: null });
		const detail = await ctx.app.inject({ method: 'GET', url: `/admin/campaigns/${created.id}`, headers: auth });
		expect(detail.statusCode).toBe(200);
		expect(detail.json().allowedTransitions).toEqual(['review', 'archived']);

		const publicList = (await ctx.app.inject({ method: 'GET', url: '/public/campaigns', headers: headers(tenant) })).json();
		expect(publicList.campaigns.map((campaign: { slug: string }) => campaign.slug)).not.toContain('honda-wave');
		const page = await ctx.app.inject({ method: 'GET', url: '/public/campaigns/honda-wave', headers: headers(tenant) });
		expect(page.statusCode).toBe(404);
	});

	it('cannot be published or opened until it has dates, then still waits for the approvals', async () => {
		const auth = await adminHeaders(ctx, tenant);
		const transition = (to: string) => ctx.app.inject({ method: 'POST', url: `/admin/campaigns/${created.id}/transition`, headers: auth, payload: { to } });
		await ctx.app.inject({
			method: 'POST',
			url: `/admin/campaigns/${created.id}/prizes`,
			headers: auth,
			payload: { kind: 'vehicle', title: 'Honda Wave 0 km', declaredValueMinor: 0, quantity: 1, alternatesCount: 0 }
		});
		expect((await transition('review')).statusCode).toBe(200);
		const undated = await transition('published');
		expect(undated.statusCode).toBe(409);
		expect(undated.json().error).toMatchObject({ code: 'missing_schedule', message: 'Definí la apertura y el cierre antes de publicar o abrir la campaña' });

		const dated = await ctx.app.inject({
			method: 'PATCH',
			url: `/admin/campaigns/${created.id}`,
			headers: auth,
			payload: { opensAt: '2026-11-01T03:00:00Z', closesAt: '2026-12-20T23:00:00Z' }
		});
		expect(dated.statusCode).toBe(200);
		expect((await transition('published')).statusCode).toBe(200);
		const open = await transition('open');
		expect(open.statusCode).toBe(409);
		expect(open.json().error.code).toBe('compliance_gate_closed');
	});

	it('keeps the dates once published: they are no longer cleared', async () => {
		const response = await ctx.app.inject({ method: 'PATCH', url: `/admin/campaigns/${created.id}`, headers: await adminHeaders(ctx, tenant), payload: { opensAt: null, closesAt: null } });
		expect(response.statusCode).toBe(409);
		expect(response.json().error.code).toBe('missing_schedule');
	});

	it('takes dates when they are known, in order, and the organization time zone unless told otherwise', async () => {
		const response = await create(
			body({ slug: 'con-fechas', timezone: 'America/Montevideo', opensAt: '2026-12-01T03:00:00Z', closesAt: '2026-12-24T23:00:00Z', drawAt: '2026-12-26T23:00:00Z' })
		);
		expect(response.statusCode).toBe(201);
		expect(response.json()).toMatchObject({
			status: 'draft',
			timezone: 'America/Montevideo',
			opensAt: '2026-12-01T03:00:00.000Z',
			closesAt: '2026-12-24T23:00:00.000Z',
			drawAt: '2026-12-26T23:00:00.000Z'
		});
	});

	it('refuses dates out of order, field by field, and creates nothing', async () => {
		const reversed = await create(body({ slug: 'al-reves', opensAt: '2026-12-24T23:00:00Z', closesAt: '2026-12-01T03:00:00Z' }));
		expect(reversed.statusCode).toBe(400);
		expect(reversed.json().error.details.fieldErrors).toEqual({ closesAt: ['El cierre tiene que ser posterior a la apertura'] });
		const early = await create(body({ slug: 'al-reves', opensAt: '2026-12-01T03:00:00Z', closesAt: '2026-12-24T23:00:00Z', drawAt: '2026-12-20T00:00:00Z' }));
		expect(early.statusCode).toBe(400);
		expect(early.json().error.details.fieldErrors).toEqual({ drawAt: ['El sorteo tiene que ser posterior al cierre'] });
		const rows = await ctx.db.withTenant(tenant.id, (tx) => tx.select().from(s.campaigns).where(eq(s.campaigns.slug, 'al-reves')));
		expect(rows).toEqual([]);
	});

	it('refuses a slug the organization already uses, and an invalid one', async () => {
		const before = await ctx.db.withTenant(tenant.id, (tx) => tx.select({ id: s.campaigns.id }).from(s.campaigns));
		const taken = await create(body());
		expect(taken.statusCode).toBe(409);
		expect(taken.json().error).toMatchObject({ code: 'slug_taken', message: 'Ya hay una campaña con esa dirección', details: { fieldErrors: { slug: ['Ya hay una campaña con esa dirección'] } } });
		const invalid = await create(body({ slug: 'Honda Wave!' }));
		expect(invalid.statusCode).toBe(400);
		expect(invalid.json().error.details.fieldErrors.slug).toEqual(['Usá minúsculas, números y guiones']);
		const after = await ctx.db.withTenant(tenant.id, (tx) => tx.select({ id: s.campaigns.id }).from(s.campaigns));
		expect(after).toHaveLength(before.length);
	});

	it('allows the same slug in another organization, which never sees the first one', async () => {
		const response = await create(body(), undefined, other);
		expect(response.statusCode).toBe(201);
		expect(response.json().id).not.toBe(created.id);
		const foreign = await ctx.app.inject({ method: 'GET', url: `/admin/campaigns/${created.id}`, headers: await adminHeaders(ctx, other) });
		expect(foreign.statusCode).toBe(404);
	});

	it("refuses another organization's products for the chances", async () => {
		const [foreign] = await ctx.db.withTenant(other.id, (tx) => tx.select({ id: s.productVariants.productId }).from(s.productVariants).where(eq(s.productVariants.id, other.manualVariantId)));
		const response = await create(body({ slug: 'ajena', chancesPerProduct: { [foreign!.id]: 1 } }));
		expect(response.statusCode).toBe(400);
		expect(response.json().error).toMatchObject({ code: 'unknown_product', details: { fieldErrors: { chancesPerProduct: ['Elegí productos de tu catálogo'] } } });
		const rows = await ctx.db.withTenant(tenant.id, (tx) => tx.select().from(s.campaigns).where(eq(s.campaigns.slug, 'ajena')));
		expect(rows).toEqual([]);
	});

	it('is refused to roles without campaigns.manage', async () => {
		const response = await create(body({ slug: 'operador' }), await adminHeaders(ctx, tenant, tenant.operatorId));
		expect(response.statusCode).toBe(403);
		const rows = await ctx.db.withTenant(tenant.id, (tx) => tx.select().from(s.campaigns).where(eq(s.campaigns.slug, 'operador')));
		expect(rows).toEqual([]);
	});

	it('is allowed to platform admins, audited as such', async () => {
		const auth = headers(tenant, { authorization: `Bearer ${await ctx.signAdmin(platformAdmin, 'newcamp-platform@test')}` });
		const response = await create(body({ slug: 'plataforma' }), auth);
		expect(response.statusCode).toBe(201);
		const [event] = await ctx.db.withTenant(tenant.id, (tx) =>
			tx.select().from(s.auditEvents).where(and(eq(s.auditEvents.action, 'campaign.created'), eq(s.auditEvents.targetId, response.json().id)))
		);
		expect(event).toMatchObject({ actorType: 'platform_admin', actorId: platformAdmin });
	});
});

describe('creating a campaign: races and field errors', () => {
	it('gives the slug to one of several simultaneous creations and refuses the rest as taken', async () => {
		const auth = await adminHeaders(ctx, tenant);
		const responses = await Promise.all(Array.from({ length: 6 }, () => create(body({ slug: 'carrera' }), auth)));
		const statuses = responses.map((response) => response.statusCode).sort();
		expect(statuses).toEqual([201, 409, 409, 409, 409, 409]);
		for (const response of responses.filter((response) => response.statusCode === 409)) {
			expect(response.json().error).toMatchObject({ code: 'slug_taken', details: { fieldErrors: { slug: ['Ya hay una campaña con esa dirección'] } } });
		}
		const rows = await ctx.db.withTenant(tenant.id, (tx) => tx.select().from(s.campaigns).where(eq(s.campaigns.slug, 'carrera')));
		expect(rows).toHaveLength(1);
	});

	it('names the nested field of each error', async () => {
		const response = await create(body({ slug: 'anidada', eligibility: { minAge: 10, residency: 'R' }, seo: { title: 'x'.repeat(71), description: 'y'.repeat(201) } }));
		expect(response.statusCode).toBe(400);
		expect(response.json().error.details.fieldErrors).toEqual({
			'eligibility.minAge': ['La edad mínima va de 16 a 99'],
			'eligibility.residency': ['Indicá dónde tienen que residir'],
			'seo.title': ['El título para buscadores admite hasta 70 caracteres'],
			'seo.description': ['La descripción para buscadores admite hasta 200 caracteres']
		});
	});
});

describe('chances on the product page', () => {
	it('lists campaigns without dates after the dated ones', async () => {
		const undated = (await create(body({ slug: 'orden-sin-fechas', chancesPerProduct: { [manualProductId]: 1 } }))).json();
		const dated = (
			await create(body({ slug: 'orden-con-fechas', opensAt: '2026-12-01T03:00:00Z', closesAt: '2026-12-24T23:00:00Z', chancesPerProduct: { [manualProductId]: 1 } }))
		).json();
		const product = (await ctx.app.inject({ method: 'GET', url: `/admin/products/${manualProductId}`, headers: await adminHeaders(ctx, tenant) })).json();
		const ids = product.chances.map((entry: { campaignId: string }) => entry.campaignId);
		expect(ids).toContain(dated.id);
		expect(ids.at(-1)).toBe(undated.id);
	});
});
