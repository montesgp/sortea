import { randomUUID } from 'node:crypto';
import { and, count, eq, schema as s } from '@sortea/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminHeaders, createTenant, createTestContext, openCampaign, placeOrder, webhookRequest, type TenantFixture, type TestContext } from './helpers';

/**
 * odd/tasks/draw-room.md T4 (S3, S4): the draw host ("Conductor del sorteo")
 * reads the draw room, records the round's Quiniela, runs the in-app tiradas
 * and looks up coupons, and nothing else. The API is the control (PRD §4):
 * every other admin or platform route answers 403 and changes nothing.
 */
let ctx: TestContext;
let tenant: TenantFixture;
let other: TenantFixture;
const hostId = randomUUID();
const auditorId = randomUUID();
let draftId: string;
let ids: { cash: string; moto: string; kit: string };

/** Juana and Martín consent to be named as winners; Lucía does not. Two coupons each: 0000-0001, 0002-0003, 0004-0005. */
const buyers = [
	{ documentNumber: '30.111.222', firstName: 'Juana', lastName: 'Pérez', email: 'juana.perez@example.com', phone: '+54 9 11 5555-0001', city: 'Cafayate', publicity: true },
	{ documentNumber: '30.333.444', firstName: 'Martín', lastName: 'Gómez', email: 'martin.gomez@example.com', phone: '+54 9 11 5555-0002', city: 'Tilcara', publicity: true },
	{ documentNumber: '30.555.666', firstName: 'Lucía', lastName: 'Ñáñez', email: 'lucia.nanez@example.com', phone: '+54 9 11 5555-0003', city: 'Molinos', publicity: false }
];

const twenty = (...head: number[]) => [...head, ...Array.from({ length: 20 - head.length }, (_, index) => 1_000 + index)];
const quinielaBody = { source: 'Quiniela de la Ciudad, Nocturna', drawnAt: '2026-11-30T00:00:00Z', extracts: twenty(0, 4), evidenceUrl: 'https://loteria.example/extracto.pdf' };

async function as(userId: string, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown, target = tenant) {
	return ctx.app.inject({ method, url, headers: await adminHeaders(ctx, target, userId), payload: payload as Record<string, unknown> | undefined });
}
const host = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown) => as(hostId, method, url, payload);
const campaignUrl = () => `/admin/campaigns/${tenant.campaignId}`;

async function setPrize(target: TenantFixture, kind: string, patch: Record<string, unknown>) {
	const auth = await adminHeaders(ctx, target);
	const { prizes } = (await ctx.app.inject({ method: 'GET', url: `/admin/campaigns/${target.campaignId}/prizes`, headers: auth })).json() as { prizes: { id: string; kind: string }[] };
	const response = await ctx.app.inject({ method: 'PATCH', url: `/admin/prizes/${prizes.find((prize) => prize.kind === kind)!.id}`, headers: auth, payload: patch });
	expect(response.statusCode, response.body).toBe(200);
}

/** Two cash units and the moto from the Quiniela, no alternates; the kit by hand. Closed and awarding. */
async function drawTenant(label: string) {
	const target = await createTenant(ctx, label);
	ctx.clock.now = new Date('2026-10-25T15:00:00Z');
	await setPrize(target, 'cash', { quantity: 2, alternatesCount: 0, position: 1, mechanism: 'quiniela' });
	await setPrize(target, 'vehicle', { alternatesCount: 0, position: 2, mechanism: 'quiniela', imageUrl: 'https://cdn.example/moto.jpg' });
	await setPrize(target, 'product', { quantity: 1, alternatesCount: 0, position: 3 });
	await openCampaign(ctx, target);
	for (const buyer of buyers) {
		ctx.clock.now = new Date(ctx.clock.now.getTime() + 60_000);
		const order = await placeOrder(ctx, target, {
			buyer: { documentType: 'DNI', documentNumber: buyer.documentNumber, firstName: buyer.firstName, lastName: buyer.lastName, email: buyer.email, phone: buyer.phone, province: 'Salta', city: buyer.city },
			consents: { terms: true, privacy: true, marketingEmail: false, winnerPublicity: buyer.publicity, adultDeclaration: true }
		});
		const payment = ctx.simulator.pay(order.checkoutId, 'approved');
		expect((await ctx.app.inject(webhookRequest(target, payment.id))).statusCode).toBe(200);
	}
	ctx.clock.now = new Date('2026-11-29T01:00:00Z');
	expect((await as(target.ownerId, 'POST', `/admin/campaigns/${target.campaignId}/close`, undefined, target)).statusCode).toBe(200);
	expect((await as(target.ownerId, 'POST', `/admin/campaigns/${target.campaignId}/transition`, { to: 'awarding' }, target)).statusCode).toBe(200);
	ctx.clock.now = new Date('2026-11-30T12:00:00Z');
	return target;
}

/** Everything a refused request must leave alone. */
async function footprint(target = tenant) {
	return ctx.db.withTenant(target.id, async (tx) => {
		const [[awards], [tiradas], [events], [audits], [fulfillments], [voids], campaigns, [orders]] = await Promise.all([
			tx.select({ value: count() }).from(s.prizeAwards),
			tx.select({ value: count() }).from(s.appUnitDraws),
			tx.select({ value: count() }).from(s.drawEvents),
			tx.select({ value: count() }).from(s.auditEvents),
			tx.select({ value: count() }).from(s.prizeFulfillments),
			tx.select({ value: count() }).from(s.prizeSlotVoids),
			tx.select({ id: s.campaigns.id, status: s.campaigns.status, title: s.campaigns.title, round: s.campaigns.currentRound, updatedAt: s.campaigns.updatedAt }).from(s.campaigns),
			tx.select({ value: count() }).from(s.orders)
		]);
		const decided = await tx.select({ id: s.prizeAwards.id, status: s.prizeAwards.status }).from(s.prizeAwards);
		return {
			awards: awards!.value,
			tiradas: tiradas!.value,
			events: events!.value,
			audits: audits!.value,
			fulfillments: fulfillments!.value,
			voids: voids!.value,
			orders: orders!.value,
			campaigns: campaigns.sort((a, b) => a.id.localeCompare(b.id)),
			decided: decided.sort((a, b) => a.id.localeCompare(b.id))
		};
	});
}

/** Nothing private of any buyer: documents, emails, phones, and nothing at all of Lucía beyond her masked name. */
function expectNoPersonalData(body: string) {
	for (const buyer of buyers) for (const value of [buyer.documentNumber, buyer.email, buyer.phone, '5555-000', '@example.com']) expect(body, value).not.toContain(value);
	for (const value of ['Lucía', 'Ñáñez', 'Molinos']) expect(body, value).not.toContain(value);
}

beforeAll(async () => {
	ctx = await createTestContext();
	other = await drawTenant('host-other');
	tenant = await drawTenant('host');
	await ctx.db.withPlatform((db) =>
		db.insert(s.organizationMembers).values([
			{ organizationId: tenant.id, userId: hostId, email: `host@${tenant.host}`, role: 'draw_host' },
			{ organizationId: tenant.id, userId: auditorId, email: `auditor@${tenant.host}`, role: 'auditor' }
		])
	);
	const rows = await ctx.db.withTenant(tenant.id, (tx) => tx.select({ id: s.prizes.id, kind: s.prizes.kind }).from(s.prizes).where(eq(s.prizes.campaignId, tenant.campaignId)));
	const of = (kind: string) => rows.find((row) => row.kind === kind)!.id;
	ids = { cash: of('cash'), moto: of('vehicle'), kit: of('product') };
	// A draft and an archived campaign of the same organization: not in the draw room.
	draftId = randomUUID();
	await ctx.db.withTenant(tenant.id, async (tx) => {
		const [campaign] = await tx.select().from(s.campaigns).where(eq(s.campaigns.id, tenant.campaignId));
		await tx.insert(s.campaigns).values({ ...campaign!, id: draftId, slug: `draft-${draftId.slice(0, 8)}`, status: 'draft', title: 'Borrador' });
		const archived = randomUUID();
		await tx.insert(s.campaigns).values({ ...campaign!, id: archived, slug: `old-${archived.slice(0, 8)}`, status: 'archived', title: 'Archivada' });
	});
});
afterAll(() => ctx.close());

describe('the draw host session', () => {
	it('carries the role and only draws.run', async () => {
		const response = await host('GET', '/admin/session');
		expect(response.statusCode, response.body).toBe(200);
		expect(response.json()).toMatchObject({ role: 'draw_host', permissions: ['draws.run'] });
	});

	it('the roles that operate campaigns get draws.run in their session too', async () => {
		expect((await as(tenant.operatorId, 'GET', '/admin/session')).json().permissions).toContain('draws.run');
		expect((await as(tenant.ownerId, 'GET', '/admin/session')).json().permissions).toContain('draws.run');
		expect((await as(auditorId, 'GET', '/admin/session')).json().permissions).not.toContain('draws.run');
	});
});

describe('the draw room', () => {
	it('lists the organization campaigns that have a draw to run or show, without drafts or archived ones', async () => {
		const response = await host('GET', '/admin/draw-room/campaigns');
		expect(response.statusCode, response.body).toBe(200);
		const { campaigns } = response.json() as { campaigns: { id: string }[] };
		expect(campaigns).toEqual([
			{ id: tenant.campaignId, slug: tenant.campaignSlug, title: 'Moto 0 km', subtitle: null, status: 'awarding', timezone: 'America/Argentina/Buenos_Aires', drawAt: null, round: 1 }
		]);
		expect(campaigns.map((campaign) => campaign.id)).not.toContain(other.campaignId);
	});

	it('shows the campaign, prizes, coupons and manifest before the Quiniela, with nothing private', async () => {
		const response = await host('GET', `/admin/draw-room/campaigns/${tenant.campaignId}`);
		expect(response.statusCode, response.body).toBe(200);
		const room = response.json();
		expect(Object.keys(room).sort()).toEqual(['appDraw', 'appPrizes', 'campaign', 'coupons', 'manifest', 'prizes', 'quinielaDraw', 'winners']);
		expect(room.campaign).toEqual({
			id: tenant.campaignId,
			slug: tenant.campaignSlug,
			title: 'Moto 0 km',
			subtitle: null,
			status: 'awarding',
			timezone: 'America/Argentina/Buenos_Aires',
			drawAt: null,
			entryDigits: 4,
			awardOrder: 'first_to_last',
			round: 1
		});
		expect(room.prizes).toEqual([
			{ id: ids.cash, position: 1, title: '$100.000', quantity: 2, mechanism: 'quiniela', imageUrl: null },
			{ id: ids.moto, position: 2, title: 'Moto', quantity: 1, mechanism: 'quiniela', imageUrl: 'https://cdn.example/moto.jpg' },
			{ id: ids.kit, position: 3, title: 'Kit', quantity: 1, mechanism: 'manual', imageUrl: null }
		]);
		expect(room.coupons).toEqual({ eligible: 6 });
		expect(room.manifest).toEqual({ round: 1, sha256: expect.stringMatching(/^[0-9a-f]{64}$/), eligibleCount: 6, publishedAt: expect.any(String) });
		expect(room.quinielaDraw).toBeNull();
		expect(room.winners).toEqual([]);
		expect(room.appDraw).toEqual({ tiradas: [], units: [], candidateCount: null, reason: 'Primero registrá el resultado de la Quiniela de esta ronda' });
		expectNoPersonalData(response.body);
	});

	it('is the organization own: another organization campaign is not found, a draft neither', async () => {
		expect((await host('GET', `/admin/draw-room/campaigns/${other.campaignId}`)).statusCode).toBe(404);
		expect((await host('GET', `/admin/draw-room/campaigns/${draftId}`)).statusCode).toBe(404);
		expect((await host('GET', `/admin/draw-room/campaigns/not-a-uuid`)).statusCode).toBe(400);
	});

	it('needs draws.run: an auditor gets 403', async () => {
		expect((await as(auditorId, 'GET', '/admin/draw-room/campaigns')).statusCode).toBe(403);
		expect((await as(auditorId, 'GET', `/admin/draw-room/campaigns/${tenant.campaignId}`)).statusCode).toBe(403);
	});
});

describe('the draw host runs the draw', () => {
	it('previews and records the Quiniela, and gets the draw room back with masked names and only consented public names', async () => {
		const before = await footprint();
		const preview = await host('POST', `${campaignUrl()}/quiniela/preview`, quinielaBody);
		expect(preview.statusCode, preview.body).toBe(200);
		expectNoPersonalData(preview.body);
		const recorded = await host('POST', `${campaignUrl()}/quiniela`, { ...quinielaBody, digest: preview.json().digest });
		expect(recorded.statusCode, recorded.body).toBe(200);
		expectNoPersonalData(recorded.body);
		const room = recorded.json();
		expect(Object.keys(room).sort()).toEqual(['appDraw', 'appPrizes', 'campaign', 'coupons', 'manifest', 'prizes', 'quinielaDraw', 'winners']);
		expect(room.quinielaDraw).toEqual({ round: 1, source: quinielaBody.source, drawnAt: '2026-11-30T00:00:00.000Z', extracts: quinielaBody.extracts, evidenceUrl: quinielaBody.evidenceUrl });
		expect(room.winners).toEqual([
			{ prizeId: ids.cash, prizeTitle: '$100.000', position: 1, slot: 1, round: 1, role: 'winner', source: 'quiniela', entryNumber: '0000', maskedName: 'Ju*** P.', identity: { name: 'Juana Pérez', city: 'Cafayate', chances: 2 } },
			{ prizeId: ids.cash, prizeTitle: '$100.000', position: 1, slot: 2, round: 1, role: 'winner', source: 'quiniela', entryNumber: '0004', maskedName: 'Lu*** Ñ.', identity: null }
		]);
		expect(room.appDraw).toEqual({
			tiradas: [],
			units: [{ prizeId: ids.moto, prizeTitle: 'Moto', slot: 1, state: 'vacant' }],
			candidateCount: 4,
			reason: null
		});
		const after = await footprint();
		expect(after.awards).toBe(before.awards + 2);
		const [audited] = await ctx.db.withTenant(tenant.id, (tx) => tx.select().from(s.auditEvents).where(eq(s.auditEvents.action, 'award.quiniela_recorded')));
		expect(audited).toMatchObject({ actorType: 'admin', actorId: hostId });
		// The same view as a read.
		expect((await host('GET', `/admin/draw-room/campaigns/${tenant.campaignId}`)).json()).toEqual(room);
	});

	it('runs the in-app draw: preview, a tirada, the units, its replay, and the legacy one-shot read', async () => {
		const preview = await host('GET', `${campaignUrl()}/app-draw/preview`);
		expect(preview.statusCode, preview.body).toBe(200);
		expectNoPersonalData(preview.body);
		const drawn = await host('POST', `${campaignUrl()}/app-draw/units`, { prizeId: ids.moto, slot: 1 });
		expect(drawn.statusCode, drawn.body).toBe(201);
		expectNoPersonalData(drawn.body);
		const tirada = drawn.json();
		expect(['0001', '0002', '0003', '0005']).toContain(tirada.pick.entryNumber);
		const units = await host('GET', `${campaignUrl()}/app-draw/units`);
		expect(units.statusCode).toBe(200);
		expect(units.json().tiradas).toHaveLength(1);
		expect((await host('GET', `${campaignUrl()}/app-draw/units/1`)).json()).toEqual(tirada);
		// Reachable: no one-shot draw was stored, so it says so (not a 403).
		const legacy = await host('GET', `${campaignUrl()}/app-draw`);
		expect(legacy.statusCode).toBe(404);
		expect(legacy.json().error.code).toBe('app_draw_missing');
		const legacyRun = await host('POST', `${campaignUrl()}/app-draw`);
		expect(legacyRun.statusCode).toBe(409);
		expect(legacyRun.json().error.code).toBe('app_draw_per_unit');

		const room = (await host('GET', `/admin/draw-room/campaigns/${tenant.campaignId}`)).json();
		expect(room.winners.at(-1)).toMatchObject({ prizeId: ids.moto, slot: 1, source: 'app_draw', entryNumber: tirada.pick.entryNumber, maskedName: tirada.pick.maskedName });
		expect(room.appDraw.tiradas).toHaveLength(1);
		expect(room.appDraw.units).toEqual([]);
		const [audited] = await ctx.db.withTenant(tenant.id, (tx) => tx.select().from(s.auditEvents).where(eq(s.auditEvents.action, 'award.app_unit_drawn')));
		expect(audited).toMatchObject({ actorId: hostId });
	});

	it('looks up coupons with the live identity rule: a consenting winner named, a non-consenting one withheld', async () => {
		const context = await host('GET', `${campaignUrl()}/coupon-lookup/context`);
		expect(context.statusCode).toBe(200);
		const named = await host('GET', `${campaignUrl()}/coupon-lookup?coupon=0000`);
		expect(named.statusCode, named.body).toBe(200);
		expect(named.json().identity).toEqual({ visibility: 'shown', name: 'Juana Pérez', city: 'Cafayate', chances: 2 });
		const withheld = await host('GET', `${campaignUrl()}/coupon-lookup?coupon=0004`);
		expect(withheld.json().identity).toEqual({ visibility: 'withheld' });
		expectNoPersonalData(withheld.body);
	});
});

describe('the draw host cannot manage', () => {
	it('gets 403 on decisions, delivery, void, results, transitions, reopen and the award board, and nothing changes', async () => {
		const [award] = await ctx.db.withTenant(tenant.id, (tx) =>
			tx.select({ id: s.prizeAwards.id }).from(s.prizeAwards).where(and(eq(s.prizeAwards.campaignId, tenant.campaignId), eq(s.prizeAwards.prizeId, ids.cash), eq(s.prizeAwards.slot, 1)))
		);
		const before = await footprint();
		const attempts = [
			['POST', `/admin/awards/${award!.id}/decision`, { decision: 'accepted' }],
			['PUT', `/admin/awards/${award!.id}/fulfillment`, { status: 'delivered' }],
			['POST', `${campaignUrl()}/awards/${ids.kit}/slots/1/void`, { reason: 'Nadie lo puede ganar' }],
			['PUT', `${campaignUrl()}/awards/${ids.kit}/slots/1`, { winner: 1 }],
			['POST', `${campaignUrl()}/draw-events`, { kind: 'result_published', title: 'Resultados', occurredAt: ctx.clock.now.toISOString() }],
			['POST', `${campaignUrl()}/transition`, { to: 'fulfilled' }],
			['POST', `${campaignUrl()}/reopen`, {}],
			['PATCH', campaignUrl(), { title: 'Otra' }],
			['GET', `${campaignUrl()}/awards`, undefined],
			['GET', campaignUrl(), undefined],
			['GET', '/admin/campaigns', undefined],
			['GET', '/admin/orders', undefined],
			['GET', '/admin/overview', undefined],
			['GET', '/admin/audit', undefined],
			['GET', '/admin/settings', undefined]
		] as const;
		for (const [method, url, payload] of attempts) {
			const response = await host(method, url, payload);
			expect(response.statusCode, `${method} ${url}: ${response.body}`).toBe(403);
		}
		expect(await footprint()).toEqual(before);
	});

	it('gets 403 on every registered admin and platform route outside the draw allow-list, so a new route cannot leak by default', async () => {
		const allowed = new Set([
			'GET /admin/session',
			'GET /admin/draw-room/campaigns',
			'GET /admin/draw-room/campaigns/:id',
			'POST /admin/campaigns/:id/quiniela/preview',
			'POST /admin/campaigns/:id/quiniela',
			'GET /admin/campaigns/:id/app-draw/preview',
			'POST /admin/campaigns/:id/app-draw',
			'GET /admin/campaigns/:id/app-draw',
			'GET /admin/campaigns/:id/app-draw/units',
			'POST /admin/campaigns/:id/app-draw/units',
			'GET /admin/campaigns/:id/app-draw/units/:sequence',
			'GET /admin/campaigns/:id/app-draw/prizes',
			'POST /admin/campaigns/:id/app-draw/prizes/:prizeId',
			'GET /admin/campaigns/:id/coupon-lookup/context',
			'GET /admin/campaigns/:id/coupon-lookup'
		]);
		const routes = ctx.app.registeredRoutes.filter((route) => route.method !== 'HEAD' && /^\/(admin|platform)\//.test(route.url));
		const keys = routes.map((route) => `${route.method} ${route.url}`);
		// The allow-list names real routes, so it cannot go stale silently.
		for (const key of allowed) expect(keys, key).toContain(key);
		const denied = routes.filter((route) => !allowed.has(`${route.method} ${route.url}`));
		expect(denied.length).toBeGreaterThan(60);
		const before = await footprint();
		const params: Record<string, string> = { id: tenant.campaignId, sequence: '1', slot: '1', prizeId: ids.kit, kind: 'legal', hostname: 'x.test', integrationId: randomUUID(), userId: randomUUID() };
		const leaks: string[] = [];
		for (const route of denied) {
			const url = route.url.replace(/:([A-Za-z]+)/g, (_, name: string) => params[name] ?? randomUUID());
			const response = await host(route.method as 'GET', url, ['GET', 'DELETE'].includes(route.method) ? undefined : {});
			if (response.statusCode !== 403) leaks.push(`${route.method} ${route.url}: ${response.statusCode} ${response.body.slice(0, 120)}`);
		}
		expect(leaks).toEqual([]);
		expect(await footprint()).toEqual(before);
	});
});
