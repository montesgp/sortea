import { randomUUID } from 'node:crypto';
import { and, asc, eq, schema as s } from '@sortea/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminHeaders, createTenant, createTestContext, headers, openCampaign, orderByReference, placeOrder, type TenantFixture, type TestContext } from './helpers';

/**
 * Tracking links per video (odd/tasks/tracking-links.md S1-S3): the back office creates and
 * archives them, the web resolves a landing code, and a purchase records every valid link its
 * buyer came through, marking the last one. Attribution never changes the order itself.
 */
let ctx: TestContext;
let tenant: TenantFixture;
let other: TenantFixture;

interface LinkView {
	id: string;
	name: string;
	channel: string;
	note: string | null;
	code: string;
	url: string;
	createdAt: string;
	archivedAt: string | null;
}

const later = (minutes: number) => (ctx.clock.now = new Date(ctx.clock.now.getTime() + minutes * 60_000));
const minutesAgo = (minutes: number) => new Date(ctx.clock.now.getTime() - minutes * 60_000).toISOString();

async function createLink(target: TenantFixture, body: Record<string, unknown>, campaignId = target.campaignId, userId = target.ownerId) {
	return ctx.app.inject({ method: 'POST', url: `/admin/campaigns/${campaignId}/tracking-links`, headers: await adminHeaders(ctx, target, userId), payload: body });
}

async function newLink(target: TenantFixture, name: string, channel = 'instagram', campaignId = target.campaignId): Promise<LinkView> {
	const response = await createLink(target, { name, channel }, campaignId);
	expect(response.statusCode, response.body).toBe(201);
	return response.json().link as LinkView;
}

async function attributionsOf(reference: string) {
	const order = await orderByReference(ctx, tenant, reference);
	const rows = await ctx.db.withTenant(tenant.id, (tx) =>
		tx
			.select({ code: s.trackingLinks.code, touchedAt: s.orderAttributions.touchedAt, isLast: s.orderAttributions.isLast })
			.from(s.orderAttributions)
			.innerJoin(s.trackingLinks, eq(s.trackingLinks.id, s.orderAttributions.trackingLinkId))
			.where(eq(s.orderAttributions.orderId, order.id))
			.orderBy(asc(s.orderAttributions.touchedAt))
	);
	return { order, rows };
}

/** A second campaign of the tenant that already closed, with a link made while it was open. */
async function closedCampaignLink(): Promise<string> {
	const campaignId = randomUUID();
	const code = `cl${randomUUID().replace(/-/g, '').slice(0, 6)}`;
	await ctx.db.withPlatform(async (db) => {
		await db.insert(s.campaigns).values({
			id: campaignId,
			organizationId: tenant.id,
			slug: `cerrada-${campaignId.slice(0, 6)}`,
			title: 'Cerrada',
			summary: 'Campaña cerrada',
			status: 'closed',
			timezone: 'UTC',
			opensAt: new Date('2026-09-01T00:00:00Z'),
			closesAt: new Date('2026-10-01T00:00:00Z')
		});
		await db.insert(s.trackingLinks).values({ organizationId: tenant.id, campaignId, name: 'Viejo', channel: 'facebook', code, createdAt: new Date('2026-09-02T00:00:00Z') });
	});
	return code;
}

beforeAll(async () => {
	ctx = await createTestContext();
	tenant = await createTenant(ctx, 'links');
	other = await createTenant(ctx, 'links-other');
	await openCampaign(ctx, tenant);
	await openCampaign(ctx, other);
});
afterAll(() => ctx.close());

describe('tracking links in the back office (S1)', () => {
	it('creates a link with a short code and its full shareable URL on the primary hostname, audited without personal data', async () => {
		const response = await createLink(tenant, { name: '  Reel moto roja  ', channel: 'instagram', note: 'Historia del viernes' });
		expect(response.statusCode, response.body).toBe(201);
		const link = response.json().link as LinkView;
		expect(link).toMatchObject({ name: 'Reel moto roja', channel: 'instagram', note: 'Historia del viernes', archivedAt: null });
		expect(link.code).toMatch(/^[a-z0-9]{8}$/);
		expect(link.url).toBe(`https://${tenant.host}/?src=${link.code}`);

		const [event] = await ctx.db.withTenant(tenant.id, (tx) =>
			tx.select().from(s.auditEvents).where(and(eq(s.auditEvents.action, 'tracking_link.created'), eq(s.auditEvents.targetId, link.id)))
		);
		expect(event).toMatchObject({ actorType: 'admin', actorId: tenant.ownerId, targetType: 'tracking_link' });
		expect(event!.metadata).toEqual({ campaignId: tenant.campaignId, channel: 'instagram', code: link.code });
	});

	it('lists the campaign links, newest first, with the campaign they count for', async () => {
		const first = await newLink(tenant, 'Lista uno', 'tiktok');
		ctx.clock.now = new Date(ctx.clock.now.getTime() + 60_000);
		const second = await newLink(tenant, 'Lista dos', 'youtube');
		const response = await ctx.app.inject({ method: 'GET', url: `/admin/campaigns/${tenant.campaignId}/tracking-links`, headers: await adminHeaders(ctx, tenant) });
		expect(response.statusCode, response.body).toBe(200);
		const body = response.json() as { campaign: { id: string; title: string; takesTouches: boolean }; links: LinkView[] };
		expect(body.campaign).toMatchObject({ id: tenant.campaignId, title: 'Moto 0 km', takesTouches: true });
		const ids = body.links.map((link) => link.id);
		expect(ids.indexOf(second.id)).toBeLessThan(ids.indexOf(first.id));
		expect(body.links.find((link) => link.id === first.id)).toMatchObject({ name: 'Lista uno', channel: 'tiktok', url: `https://${tenant.host}/?src=${first.code}` });
	});

	it('archives a link, keeping its code, and audits it', async () => {
		const link = await newLink(tenant, 'Para archivar');
		const auth = await adminHeaders(ctx, tenant);
		const archived = await ctx.app.inject({ method: 'POST', url: `/admin/campaigns/${tenant.campaignId}/tracking-links/${link.id}/archive`, headers: auth });
		expect(archived.statusCode, archived.body).toBe(200);
		expect(archived.json().link).toMatchObject({ id: link.id, code: link.code, archivedAt: ctx.clock.now.toISOString() });
		// Archiving again changes nothing.
		const again = await ctx.app.inject({ method: 'POST', url: `/admin/campaigns/${tenant.campaignId}/tracking-links/${link.id}/archive`, headers: auth });
		expect(again.json().link.archivedAt).toBe(ctx.clock.now.toISOString());
		const events = await ctx.db.withTenant(tenant.id, (tx) =>
			tx.select().from(s.auditEvents).where(and(eq(s.auditEvents.action, 'tracking_link.archived'), eq(s.auditEvents.targetId, link.id)))
		);
		expect(events).toHaveLength(1);
		expect(events[0]!.metadata).toEqual({ campaignId: tenant.campaignId, code: link.code });
	});

	it('needs the permission that manages campaigns', async () => {
		const operator = await adminHeaders(ctx, tenant, tenant.operatorId);
		const link = await newLink(tenant, 'Del dueño');
		const before = await ctx.db.withTenant(tenant.id, (tx) => tx.select().from(s.trackingLinks));
		for (const request of [
			{ method: 'GET' as const, url: `/admin/campaigns/${tenant.campaignId}/tracking-links` },
			{ method: 'POST' as const, url: `/admin/campaigns/${tenant.campaignId}/tracking-links`, payload: { name: 'Operador', channel: 'instagram' } },
			{ method: 'POST' as const, url: `/admin/campaigns/${tenant.campaignId}/tracking-links/${link.id}/archive` }
		]) {
			const response = await ctx.app.inject({ ...request, headers: operator });
			expect(response.statusCode, request.url).toBe(403);
		}
		expect(await ctx.db.withTenant(tenant.id, (tx) => tx.select().from(s.trackingLinks))).toEqual(before);
	});

	it('refuses invalid data, campaigns of other organizations and closed campaigns, storing nothing', async () => {
		const before = await ctx.db.withPlatform((db) => db.select().from(s.trackingLinks));
		const invalid = await createLink(tenant, { name: 'R', channel: 'myspace' });
		expect(invalid.statusCode).toBe(400);
		const foreign = await createLink(tenant, { name: 'Ajena', channel: 'instagram' }, other.campaignId);
		expect(foreign.statusCode).toBe(404);
		const foreignArchive = await ctx.app.inject({
			method: 'POST',
			url: `/admin/campaigns/${tenant.campaignId}/tracking-links/${randomUUID()}/archive`,
			headers: await adminHeaders(ctx, tenant)
		});
		expect(foreignArchive.statusCode).toBe(404);
		expect(await ctx.db.withPlatform((db) => db.select().from(s.trackingLinks))).toEqual(before);

		await closedCampaignLink();
		const [closed] = await ctx.db.withTenant(tenant.id, (tx) => tx.select({ id: s.campaigns.id }).from(s.campaigns).where(eq(s.campaigns.status, 'closed')));
		const refused = await createLink(tenant, { name: 'Tarde', channel: 'instagram' }, closed!.id);
		expect(refused.statusCode, refused.body).toBe(409);
		expect(refused.json().error).toMatchObject({ code: 'campaign_closed', message: 'La campaña ya cerró: un link nuevo no sumaría compras' });
	});
});

describe('landing code resolution (S2)', () => {
	it('answers an active link of an open campaign with the time its touches last until', async () => {
		const link = await newLink(tenant, 'Landing');
		const response = await ctx.app.inject({ method: 'GET', url: `/public/tracking-links/${link.code}`, headers: headers(tenant) });
		expect(response.statusCode, response.body).toBe(200);
		expect(response.json()).toEqual({ code: link.code, until: '2026-11-28T23:00:00.000Z' });
	});

	it('does not know archived links, closed campaigns, other organizations or malformed codes', async () => {
		const archived = await newLink(tenant, 'Archivado');
		await ctx.app.inject({ method: 'POST', url: `/admin/campaigns/${tenant.campaignId}/tracking-links/${archived.id}/archive`, headers: await adminHeaders(ctx, tenant) });
		const foreign = await newLink(other, 'De otra');
		const closed = await closedCampaignLink();
		for (const code of [archived.code, foreign.code, closed, 'zzzz9999', 'NOT-A-CODE']) {
			const response = await ctx.app.inject({ method: 'GET', url: `/public/tracking-links/${encodeURIComponent(code)}`, headers: headers(tenant) });
			expect(response.statusCode, code).toBe(404);
		}
	});
});

describe('attribution stored with the order (S3)', () => {
	it('records every valid link the buyer came through and marks the last one', async () => {
		const a = await newLink(tenant, 'Video A');
		const b = await newLink(tenant, 'Video B', 'tiktok');
		// The visits come after the links were shared.
		later(60);
		const placed = await placeOrder(ctx, tenant, {
			attribution: {
				touches: [
					{ code: b.code, at: minutesAgo(5) },
					{ code: a.code, at: minutesAgo(30) }
				],
				channel: 'facebook'
			}
		});
		const { order, rows } = await attributionsOf(placed.reference);
		expect(rows).toEqual([
			{ code: a.code, touchedAt: new Date(minutesAgo(30)), isLast: false },
			{ code: b.code, touchedAt: new Date(minutesAgo(5)), isLast: true }
		]);
		// With links, the referrer guess is not needed.
		expect(order.sourceChannel).toBeNull();
	});

	it('drops foreign, archived, closed-campaign and unknown codes without failing the purchase', async () => {
		const valid = await newLink(tenant, 'Válido');
		const archived = await newLink(tenant, 'Archivado luego');
		await ctx.app.inject({ method: 'POST', url: `/admin/campaigns/${tenant.campaignId}/tracking-links/${archived.id}/archive`, headers: await adminHeaders(ctx, tenant) });
		const foreign = await newLink(other, 'Ajeno');
		const closed = await closedCampaignLink();
		later(60);
		const placed = await placeOrder(ctx, tenant, {
			attribution: {
				touches: [
					{ code: foreign.code, at: minutesAgo(1) },
					{ code: archived.code, at: minutesAgo(2) },
					{ code: closed, at: minutesAgo(3) },
					{ code: 'zzzz9999', at: minutesAgo(4) },
					{ code: valid.code, at: minutesAgo(10) }
				]
			}
		});
		const { rows } = await attributionsOf(placed.reference);
		expect(rows).toEqual([{ code: valid.code, touchedAt: new Date(minutesAgo(10)), isLast: true }]);
		// The other organization's data is untouched.
		expect(await ctx.db.withTenant(other.id, (tx) => tx.select().from(s.orderAttributions))).toEqual([]);
	});

	it('records the network guessed from the referrer when no link is valid', async () => {
		const placed = await placeOrder(ctx, tenant, { attribution: { touches: [{ code: 'zzzz9999', at: minutesAgo(1) }], channel: 'instagram' } });
		const { order, rows } = await attributionsOf(placed.reference);
		expect(rows).toEqual([]);
		expect(order.sourceChannel).toBe('instagram');
	});

	it('never changes the order: same prices, chances and status as without attribution', async () => {
		const link = await newLink(tenant, 'Sin efecto');
		const plain = await orderByReference(ctx, tenant, (await placeOrder(ctx, tenant)).reference);
		const tracked = await orderByReference(ctx, tenant, (await placeOrder(ctx, tenant, { attribution: { touches: [{ code: link.code, at: minutesAgo(1) }] } })).reference);
		const pick = (order: typeof plain) => ({
			status: order.status,
			subtotalMinor: order.subtotalMinor,
			deliveryFeeMinor: order.deliveryFeeMinor,
			totalMinor: order.totalMinor,
			reservedEntries: order.reservedEntries,
			campaignId: order.campaignId,
			ruleVersionId: order.ruleVersionId,
			lines: order.pricingSnapshot.lines
		});
		expect(pick(tracked)).toEqual(pick(plain));
		expect(plain.reservedEntries).toBeGreaterThan(0);
	});

	it('stores nothing for an order without touches', async () => {
		const placed = await placeOrder(ctx, tenant);
		const { order, rows } = await attributionsOf(placed.reference);
		expect(rows).toEqual([]);
		expect(order.sourceChannel).toBeNull();
	});

	it('ignores malformed attribution instead of refusing the buyer', async () => {
		const placed = await placeOrder(ctx, tenant, { attribution: { touches: [{ code: '<script>', at: 'ayer' }], channel: 'myspace' } });
		const { order, rows } = await attributionsOf(placed.reference);
		expect(rows).toEqual([]);
		expect(order.sourceChannel).toBeNull();
	});
});
