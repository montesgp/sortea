import { randomUUID } from 'node:crypto';
import { schema as s } from '@sortea/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminHeaders, checkoutBody, createTenant, createTestContext, openCampaign, placeOrder, webhookRequest, type TenantFixture, type TestContext } from './helpers';

/**
 * Tracking link performance (odd/tasks/tracking-links.md S4): per link, every paid purchase it
 * took part in ("participó") and those where it was the last link ("último"), purchases without
 * a link by guessed network, network and campaign totals, and the campaigns comparison. Only
 * paid purchases count; refunded and charged-back ones do not. No personal data is returned.
 */
let ctx: TestContext;
let tenant: TenantFixture;
let other: TenantFixture;
let supportId: string;

const UNIT = 1_200_000;
const later = (minutes: number) => (ctx.clock.now = new Date(ctx.clock.now.getTime() + minutes * 60_000));
const minutesAgo = (minutes: number) => new Date(ctx.clock.now.getTime() - minutes * 60_000).toISOString();

interface Block {
	purchases: number;
	buyers: number;
	chances: number;
	grossMinor: number;
	netMinor: number;
	netUnknown: number;
}
interface ReportLink {
	id: string;
	name: string;
	channel: string;
	code: string;
	archivedAt: string | null;
	otherCampaign: { id: string; title: string } | null;
	participated: Block;
	last: Block;
}
interface Report {
	campaign: { id: string; title: string; status: string; timezone: string };
	currency: string;
	links: ReportLink[];
	withoutLink: (Block & { channel: string | null })[];
	channels: (Block & { channel: string | null })[];
	total: Block;
}
interface ComparisonRow extends Block {
	id: string;
	title: string;
	status: string;
	links: number;
	withLink: number;
	withoutLink: number;
}

const links: Record<string, { id: string; code: string }> = {};
/** Net of each fixture purchase as Mercado Pago reported it; null when its fees were not reported. */
const nets: Record<string, number | null> = {};
let otherCampaignId: string;

async function newLink(target: TenantFixture, name: string, channel: string) {
	const response = await ctx.app.inject({ method: 'POST', url: `/admin/campaigns/${target.campaignId}/tracking-links`, headers: await adminHeaders(ctx, target), payload: { name, channel } });
	expect(response.statusCode, response.body).toBe(201);
	return response.json().link as { id: string; code: string };
}

const buyer = (target: TenantFixture, name: string, document: string) => ({ ...checkoutBody(target).buyer, firstName: name, documentNumber: document, email: `${name.toLowerCase()}@example.com` });

/** A purchase of `quantity` manuals (one chance each) by `name`, through `codes` (oldest first), settled as `outcome`. */
async function purchase(
	target: TenantFixture,
	label: string,
	{ name, document, quantity, codes = [], channel, outcome = 'paid', feesUnknown = false }: { name: string; document: string; quantity: number; codes?: string[]; channel?: string; outcome?: 'paid' | 'refunded' | 'charged_back' | 'pending'; feesUnknown?: boolean }
) {
	const touches = codes.map((code, index) => ({ code, at: minutesAgo(30 - index) }));
	const placed = await placeOrder(ctx, target, {
		lines: [{ variantId: target.manualVariantId, quantity }],
		buyer: buyer(target, name, document),
		attribution: { touches, ...(channel ? { channel } : {}) }
	});
	if (outcome === 'pending') return;
	const payment = ctx.simulator.pay(placed.checkoutId, 'approved');
	if (feesUnknown) ctx.simulator.tamper(payment.id, { feeMinor: null, netMinor: null });
	const confirmed = await ctx.app.inject(webhookRequest(target, payment.id));
	expect(confirmed.statusCode).toBe(200);
	nets[label] = feesUnknown ? null : payment.netMinor;
	if (outcome !== 'paid') {
		ctx.simulator.setStatus(payment.id, outcome);
		await ctx.app.inject(webhookRequest(target, payment.id));
	}
}

async function report(target = tenant, campaignId = target.campaignId, userId = target.ownerId) {
	return ctx.app.inject({ method: 'GET', url: `/admin/campaigns/${campaignId}/tracking-links/report`, headers: await adminHeaders(ctx, target, userId) });
}

async function comparison(target = tenant, userId = target.ownerId) {
	return ctx.app.inject({ method: 'GET', url: '/admin/tracking-links/campaigns-comparison', headers: await adminHeaders(ctx, target, userId) });
}

const net = (...labels: string[]) => labels.reduce((sum, label) => sum + (nets[label] ?? 0), 0);

beforeAll(async () => {
	ctx = await createTestContext();
	tenant = await createTenant(ctx, 'report');
	other = await createTenant(ctx, 'report-other');
	await openCampaign(ctx, tenant);
	await openCampaign(ctx, other);
	supportId = randomUUID();
	otherCampaignId = randomUUID();
	await ctx.db.withPlatform(async (db) => {
		await db.insert(s.organizationMembers).values({ organizationId: tenant.id, userId: supportId, email: `support@${tenant.host}`, role: 'support_agent' });
		// A second open campaign of the tenant whose link a buyer of the first one also passed through.
		await db.insert(s.campaigns).values({
			id: otherCampaignId,
			organizationId: tenant.id,
			slug: 'segunda',
			title: 'Segunda campaña',
			summary: 'Otra campaña',
			status: 'open',
			timezone: 'UTC',
			opensAt: new Date('2026-10-25T00:00:00Z'),
			closesAt: new Date('2026-12-20T00:00:00Z')
		});
	});

	Object.assign(links, {
		a: await newLink(tenant, 'Video A', 'instagram'),
		b: await newLink(tenant, 'Video B', 'tiktok'),
		c: await newLink(tenant, 'Video C', 'facebook'),
		empty: await newLink(tenant, 'Sin compras', 'instagram')
	});
	const [elsewhere] = await ctx.db.withPlatform((db) =>
		db
			.insert(s.trackingLinks)
			.values({ organizationId: tenant.id, campaignId: otherCampaignId, name: 'Video de la segunda', channel: 'youtube', code: `e${randomUUID().replace(/-/g, '').slice(0, 7)}`, createdAt: ctx.clock.now })
			.returning()
	);
	links.e = elsewhere!;
	later(60);

	await purchase(tenant, 'ana', { name: 'Ana', document: '30111111', quantity: 2, codes: [links.a!.code, links.b!.code] });
	await purchase(tenant, 'beto1', { name: 'Beto', document: '30222222', quantity: 1, codes: [links.a!.code] });
	await purchase(tenant, 'beto3', { name: 'Beto', document: '30222222', quantity: 3, codes: [links.a!.code], feesUnknown: true });
	await purchase(tenant, 'caro', { name: 'Caro', document: '30333333', quantity: 1, codes: [links.b!.code], outcome: 'refunded' });
	await purchase(tenant, 'dani', { name: 'Dani', document: '30444444', quantity: 1, codes: [links.a!.code], outcome: 'charged_back' });
	await purchase(tenant, 'gabi', { name: 'Gabi', document: '30555555', quantity: 4, codes: [links.a!.code], outcome: 'pending' });
	await purchase(tenant, 'hugo', { name: 'Hugo', document: '30666666', quantity: 1, codes: [links.c!.code] });
	await purchase(tenant, 'ivan', { name: 'Ivan', document: '30777777', quantity: 1, codes: [links.e.code] });
	await purchase(tenant, 'eva', { name: 'Eva', document: '30888888', quantity: 2, channel: 'instagram' });
	await purchase(tenant, 'fede', { name: 'Fede', document: '30999999', quantity: 1 });
	// The other organization sells through its own link.
	const foreign = await newLink(other, 'Ajeno', 'instagram');
	later(5);
	await purchase(other, 'ajeno', { name: 'Zoe', document: '31111111', quantity: 5, codes: [foreign.code] });

	// Archived after its purchase, the link keeps its row.
	const archived = await ctx.app.inject({ method: 'POST', url: `/admin/campaigns/${tenant.campaignId}/tracking-links/${links.c!.id}/archive`, headers: await adminHeaders(ctx, tenant) });
	expect(archived.statusCode).toBe(200);
});
afterAll(() => ctx.close());

describe('campaign report (S4)', () => {
	let body: Report;
	const row = (key: string) => body.links.find((link) => link.id === links[key]!.id)!;

	beforeAll(async () => {
		const response = await report();
		expect(response.statusCode, response.body).toBe(200);
		body = response.json();
	});

	it('names the campaign and its currency', () => {
		expect(body.campaign).toMatchObject({ id: tenant.campaignId, title: 'Moto 0 km', status: 'open' });
		expect(body.currency).toBe('ARS');
	});

	it('credits every paid purchase a link took part in, and only those where it was last in "último"', () => {
		expect(row('a')).toMatchObject({ name: 'Video A', channel: 'instagram', code: links.a!.code, archivedAt: null, otherCampaign: null });
		expect(row('a').participated).toEqual({ purchases: 3, buyers: 2, chances: 6, grossMinor: 6 * UNIT, netMinor: net('ana', 'beto1'), netUnknown: 1 });
		expect(row('a').last).toEqual({ purchases: 2, buyers: 1, chances: 4, grossMinor: 4 * UNIT, netMinor: net('beto1'), netUnknown: 1 });
		// The refunded purchase through B no longer counts.
		expect(row('b').participated).toEqual({ purchases: 1, buyers: 1, chances: 2, grossMinor: 2 * UNIT, netMinor: net('ana'), netUnknown: 0 });
		expect(row('b').last).toEqual(row('b').participated);
	});

	it('keeps archived links and links without purchases, and shows another campaign\'s link a purchase passed through', () => {
		expect(row('c').archivedAt).not.toBeNull();
		expect(row('c').last).toMatchObject({ purchases: 1, chances: 1, grossMinor: UNIT });
		expect(row('empty').participated).toEqual({ purchases: 0, buyers: 0, chances: 0, grossMinor: 0, netMinor: 0, netUnknown: 0 });
		expect(row('e')).toMatchObject({ name: 'Video de la segunda', channel: 'youtube', otherCampaign: { id: otherCampaignId, title: 'Segunda campaña' } });
		expect(row('e').last).toMatchObject({ purchases: 1, buyers: 1, chances: 1, grossMinor: UNIT, netMinor: net('ivan') });
		// The campaign's own links come first.
		expect(body.links.at(-1)!.id).toBe(links.e!.id);
	});

	it('lists paid purchases without a link by the network guessed from the referrer', () => {
		expect(body.withoutLink).toEqual([
			{ channel: 'instagram', purchases: 1, buyers: 1, chances: 2, grossMinor: 2 * UNIT, netMinor: net('eva'), netUnknown: 0 },
			{ channel: null, purchases: 1, buyers: 1, chances: 1, grossMinor: UNIT, netMinor: net('fede'), netUnknown: 0 }
		]);
	});

	it('totals each network and the campaign so that "último" plus "Sin link" add up', () => {
		expect(body.channels.map((channel) => [channel.channel, channel.purchases, channel.chances, channel.grossMinor])).toEqual([
			['instagram', 3, 6, 6 * UNIT],
			['facebook', 1, 1, UNIT],
			['tiktok', 1, 2, 2 * UNIT],
			['youtube', 1, 1, UNIT],
			[null, 1, 1, UNIT]
		]);
		expect(body.total).toEqual({ purchases: 7, buyers: 6, chances: 11, grossMinor: 11 * UNIT, netMinor: net('ana', 'beto1', 'hugo', 'ivan', 'eva', 'fede'), netUnknown: 1 });
		for (const key of ['purchases', 'chances', 'grossMinor', 'netMinor', 'netUnknown'] as const) {
			const sum = body.links.reduce((total, link) => total + link.last[key], 0) + body.withoutLink.reduce((total, row) => total + row[key], 0);
			expect(sum, key).toBe(body.total[key]);
			expect(body.channels.reduce((total, row) => total + row[key], 0), key).toBe(body.total[key]);
		}
	});

	it('returns no personal data', () => {
		const raw = JSON.stringify(body);
		for (const secret of ['Ana', 'Beto', 'Eva', 'example.com', '30111111', 'contactId', 'Pérez']) expect(raw).not.toContain(secret);
	});

	it('is open to roles that see sales totals, not to support agents', async () => {
		expect((await report(tenant, tenant.campaignId, tenant.operatorId)).statusCode).toBe(200);
		const refused = await report(tenant, tenant.campaignId, supportId);
		expect(refused.statusCode).toBe(403);
	});

	it('counts each campaign\'s own purchases: the second campaign lists its link but not the first campaign\'s purchase', async () => {
		const second = (await report(tenant, otherCampaignId)).json() as Report;
		expect(second.links.map((link) => [link.id, link.participated.purchases, link.otherCampaign])).toEqual([[links.e!.id, 0, null]]);
		expect(second.total.purchases).toBe(0);
	});

	it('keeps organizations apart', async () => {
		expect((await report(tenant, other.campaignId)).statusCode).toBe(404);
		const foreign = (await report(other)).json() as Report;
		expect(foreign.links.map((link) => link.name)).toEqual(['Ajeno']);
		expect(foreign.total).toMatchObject({ purchases: 1, chances: 5, grossMinor: 5 * UNIT });
	});
});

describe('campaigns comparison (S4)', () => {
	it('gives one row per campaign of the organization with the campaign report\'s totals', async () => {
		const response = await comparison();
		expect(response.statusCode, response.body).toBe(200);
		const body = response.json() as { currency: string; campaigns: ComparisonRow[] };
		expect(body.currency).toBe('ARS');
		expect(body.campaigns.map((campaign) => campaign.id).sort()).toEqual([tenant.campaignId, otherCampaignId].sort());
		const moto = body.campaigns.find((campaign) => campaign.id === tenant.campaignId)!;
		const total = ((await report()).json() as Report).total;
		expect(moto).toMatchObject({ ...total, title: 'Moto 0 km', status: 'open', links: 4, withLink: 5, withoutLink: 2 });
		expect(body.campaigns.find((campaign) => campaign.id === otherCampaignId)).toMatchObject({ purchases: 0, buyers: 0, chances: 0, grossMinor: 0, links: 1, withLink: 0, withoutLink: 0 });
		const raw = JSON.stringify(body);
		for (const secret of ['Ana', 'example.com', '30111111']) expect(raw).not.toContain(secret);
	});

	it('is open to roles that see sales totals, not to support agents, and shows only the organization\'s campaigns', async () => {
		expect((await comparison(tenant, tenant.operatorId)).statusCode).toBe(200);
		expect((await comparison(tenant, supportId)).statusCode).toBe(403);
		const foreign = (await comparison(other)).json() as { campaigns: ComparisonRow[] };
		expect(foreign.campaigns.map((campaign) => [campaign.id, campaign.purchases])).toEqual([[other.campaignId, 1]]);
	});
});
