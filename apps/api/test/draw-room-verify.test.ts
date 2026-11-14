import { randomUUID } from 'node:crypto';
import { count, eq, schema as s } from '@sortea/db';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { adminHeaders, createTenant, createTestContext, openCampaign, placeOrder, webhookRequest, type TenantFixture, type TestContext } from './helpers';

// Independent verification probes of odd/tasks/draw-room.md: partial previews never record (T5),
// a draw host is confined to its organization (T4), candidates exclude every award holder and only
// units passed over completely are drawn again (T3, S5), no personal data leaves the draw routes,
// and transparency hides the picks until results are published.
let ctx: TestContext;
let tenant: TenantFixture;
let fresh: TenantFixture;
const hostId = randomUUID();
const freshHostId = randomUUID();
let ids: { cash: string; moto: string; kit: string };
const buyers = ['30.111.001', '30.111.002', '30.111.003', '30.111.004'].map((documentNumber, i) => ({
	documentNumber,
	firstName: ['Ana', 'Beto', 'Ciro', 'Dora'][i]!,
	lastName: 'Lopez',
	email: `buyer${i}@example.com`
}));
const twenty = (...hits: number[]) => [...hits, ...Array.from({ length: 20 - hits.length }, (_, i) => 1_000 + i)];
const body = (extracts: number[]) => ({ source: 'Quiniela de la Ciudad, Nocturna', drawnAt: '2026-11-30T00:00:00Z', extracts, evidenceUrl: 'https://loteria.example/extracto.pdf' });
const as = async (t: TenantFixture, user: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
	ctx.app.inject({ method, url, headers: await adminHeaders(ctx, t, user), payload: payload as Record<string, unknown> | undefined });

async function setPrize(t: TenantFixture, kind: string, patch: Record<string, unknown>) {
	const auth = await adminHeaders(ctx, t);
	const { prizes } = (await ctx.app.inject({ method: 'GET', url: `/admin/campaigns/${t.campaignId}/prizes`, headers: auth })).json() as { prizes: { id: string; kind: string }[] };
	expect((await ctx.app.inject({ method: 'PATCH', url: `/admin/prizes/${prizes.find((p) => p.kind === kind)!.id}`, headers: auth, payload: patch })).statusCode).toBe(200);
}

/** Moto (1 unit, 1 alternate) and cash (2 units, none) by Quiniela; the kit by hand. Coupons 0000-0007. */
async function awardingTenant(label: string, host: string) {
	const t = await createTenant(ctx, label);
	ctx.clock.now = new Date('2026-10-25T15:00:00Z');
	await setPrize(t, 'vehicle', { alternatesCount: 1, position: 1, mechanism: 'quiniela' });
	await setPrize(t, 'cash', { quantity: 2, alternatesCount: 0, position: 2, mechanism: 'quiniela' });
	await setPrize(t, 'product', { quantity: 1, alternatesCount: 0, position: 3 });
	await openCampaign(ctx, t);
	for (const [i, buyer] of buyers.entries()) {
		ctx.clock.now = new Date(ctx.clock.now.getTime() + 60_000);
		const order = await placeOrder(ctx, t, {
			buyer: { documentType: 'DNI', documentNumber: buyer.documentNumber, firstName: buyer.firstName, lastName: buyer.lastName, email: buyer.email, phone: `+54 9 11 5555-010${i}`, province: 'Salta', city: 'Cafayate' },
			consents: { terms: true, privacy: true, marketingEmail: false, winnerPublicity: false, adultDeclaration: true }
		});
		expect((await ctx.app.inject(webhookRequest(t, ctx.simulator.pay(order.checkoutId, 'approved').id))).statusCode).toBe(200);
	}
	ctx.clock.now = new Date('2026-11-29T01:00:00Z');
	expect((await as(t, t.ownerId, 'POST', `/admin/campaigns/${t.campaignId}/close`)).statusCode).toBe(200);
	expect((await as(t, t.ownerId, 'POST', `/admin/campaigns/${t.campaignId}/transition`, { to: 'awarding' })).statusCode).toBe(200);
	ctx.clock.now = new Date('2026-11-30T12:00:00Z');
	await ctx.db.withPlatform((db) => db.insert(s.organizationMembers).values({ organizationId: t.id, userId: host, email: `host@${t.host}`, role: 'draw_host' }));
	return t;
}

const footprint = (t: TenantFixture) =>
	ctx.db.withTenant(t.id, async (tx) => {
		const rows = await Promise.all([s.prizeAwards, s.appUnitDraws, s.quinielaDraws, s.drawEvents, s.auditEvents].map((table) => tx.select({ v: count() }).from(table)));
		return rows.map(([row]) => row!.v);
	});

function expectNoPii(json: unknown, raw: string) {
	const walk = (value: unknown, path: string): void => {
		if (Array.isArray(value)) value.forEach((item, i) => walk(item, `${path}[${i}]`));
		else if (value && typeof value === 'object')
			for (const [key, item] of Object.entries(value)) {
				expect(/email|document|phone|address|amount|buyer/i.test(key), `${path}.${key}`).toBe(false);
				walk(item, `${path}.${key}`);
			}
	};
	walk(json, '$');
	for (const buyer of buyers) for (const text of [buyer.documentNumber, buyer.email, buyer.lastName, '5555-010']) expect(raw).not.toContain(text);
}

const decline = (t: TenantFixture, id: string) => as(t, t.ownerId, 'POST', `/admin/awards/${id}/decision`, { decision: 'declined', notes: 'No respondió en el plazo' });
const awardOf = async (t: TenantFixture, entryNumber: number) =>
	(
		await ctx.db.withTenant(t.id, (tx) =>
			tx.select({ id: s.prizeAwards.id, n: s.participationEntries.entryNumber }).from(s.prizeAwards).innerJoin(s.participationEntries, eq(s.participationEntries.id, s.prizeAwards.entryId))
		)
	).find((row) => row.n === entryNumber)!.id;
const numbers = (response: { json: () => { candidates: { entryNumber: string }[] } }) => response.json().candidates.map((candidate) => candidate.entryNumber);

beforeAll(async () => {
	ctx = await createTestContext();
	fresh = await awardingTenant('verify-fresh', freshHostId);
	tenant = await awardingTenant('verify-main', hostId);
	const rows = await ctx.db.withTenant(tenant.id, (tx) => tx.select({ id: s.prizes.id, kind: s.prizes.kind }).from(s.prizes).where(eq(s.prizes.campaignId, tenant.campaignId)));
	const of = (kind: string) => rows.find((row) => row.kind === kind)!.id;
	ids = { cash: of('cash'), moto: of('vehicle'), kit: of('product') };
});

afterAll(() => ctx.close());

it('a partial preview never records (T5)', async () => {
	const url = `/admin/campaigns/${fresh.campaignId}`;
	const before = await footprint(fresh);
	const partial = await as(fresh, freshHostId, 'POST', `${url}/quiniela/preview`, { extracts: [0, 2] });
	expect(partial.statusCode).toBe(200);
	expect(partial.json().digest).toBeNull();
	expectNoPii(partial.json(), partial.body);
	for (const payload of [{ ...body([0, 2]), digest: 'a'.repeat(64) }, { ...body(twenty(0, 2)), digest: null }, { ...body(twenty(0, 2)), digest: 'a'.repeat(64) }, { extracts: twenty(0, 2), digest: null }])
		expect([400, 409]).toContain((await as(fresh, freshHostId, 'POST', `${url}/quiniela`, payload)).statusCode);
	for (const extracts of [[], twenty(0).concat([5]), [10_000], [-1], [1.5]]) expect((await as(fresh, freshHostId, 'POST', `${url}/quiniela/preview`, { extracts })).statusCode).toBe(400);
	expect(await footprint(fresh)).toEqual(before);
});

it('the host gets 404 on another organization and changes nothing there (T4)', async () => {
	const url = `/admin/campaigns/${fresh.campaignId}`;
	const before = await footprint(fresh);
	expect((await as(tenant, hostId, 'POST', `${url}/quiniela/preview`, body(twenty(0)))).statusCode).toBe(404);
	expect((await as(tenant, hostId, 'POST', `${url}/quiniela`, { ...body(twenty(0)), digest: 'a'.repeat(64) })).statusCode).toBe(404);
	expect((await as(tenant, hostId, 'POST', `${url}/app-draw/units`, { prizeId: ids.moto, slot: 1 })).statusCode).toBe(404);
	expect((await as(tenant, hostId, 'GET', `${url}/coupon-lookup?coupon=0000`)).statusCode).toBe(404);
	expect(await footprint(fresh)).toEqual(before);
});

it('candidates exclude every award holder; only units passed over completely are drawn again (T3, S5)', async () => {
	const url = `/admin/campaigns/${tenant.campaignId}`;
	const extracts = twenty(0, 2, 4, 6);
	const preview = await as(tenant, hostId, 'POST', `${url}/quiniela/preview`, body(extracts));
	const recorded = await as(tenant, hostId, 'POST', `${url}/quiniela`, { ...body(extracts), digest: preview.json().digest });
	expect(recorded.statusCode).toBe(200);
	expectNoPii(recorded.json(), recorded.body);
	expect(recorded.json().winners.map((w: { prizeTitle: string; slot: number; entryNumber: string }) => [w.prizeTitle, w.slot, w.entryNumber])).toEqual([
		['Moto', 1, '0000'],
		['$100.000', 1, '0002'],
		['$100.000', 2, '0004']
	]);
	let before = await footprint(tenant);
	expect((await as(tenant, hostId, 'POST', `${url}/app-draw/units`, { prizeId: ids.cash, slot: 1 })).json().error.code).toBe('unit_has_winner');
	expect((await as(tenant, hostId, 'POST', `${url}/app-draw/units`, { prizeId: ids.kit, slot: 1 })).statusCode).toBe(409);
	expect((await as(tenant, hostId, 'POST', `${url}/app-draw/units`, { prizeId: ids.cash, slot: 3 })).statusCode).toBe(400);
	expect(await footprint(tenant)).toEqual(before);

	expect((await decline(tenant, await awardOf(tenant, 2))).statusCode).toBe(200);
	ctx.clock.now = new Date(ctx.clock.now.getTime() + 60_000);
	const first = await as(tenant, hostId, 'POST', `${url}/app-draw/units`, { prizeId: ids.cash, slot: 1 });
	expect(first.statusCode).toBe(201);
	expect(numbers(first)).toEqual(['0001', '0003', '0005', '0007']);
	expectNoPii(first.json(), first.body);

	expect((await decline(tenant, await awardOf(tenant, 0))).statusCode).toBe(200);
	before = await footprint(tenant);
	expect((await as(tenant, hostId, 'POST', `${url}/app-draw/units`, { prizeId: ids.moto, slot: 1 })).json().error.code).toBe('unit_has_winner');
	expect(await footprint(tenant)).toEqual(before);

	expect((await decline(tenant, await awardOf(tenant, 6))).statusCode).toBe(200);
	ctx.clock.now = new Date(ctx.clock.now.getTime() + 60_000);
	const moto = await as(tenant, hostId, 'POST', `${url}/app-draw/units`, { prizeId: ids.moto, slot: 1 });
	expect(moto.statusCode).toBe(201);
	expect(numbers(moto)).toEqual(['0001', '0003', '0005', '0007'].filter((n) => n !== first.json().pick.entryNumber));
	const [winner] = await ctx.db.withTenant(tenant.id, (tx) =>
		tx
			.select({ rank: s.prizeAwards.rank })
			.from(s.prizeAwards)
			.innerJoin(s.participationEntries, eq(s.participationEntries.id, s.prizeAwards.entryId))
			.where(eq(s.participationEntries.entryNumber, Number(moto.json().pick.entryNumber)))
	);
	expect(winner!.rank).toBe(2);
	const room = await as(tenant, hostId, 'GET', `/admin/draw-room/campaigns/${tenant.campaignId}`);
	expectNoPii(room.json(), room.body);
});

it('transparency shows no pick before the results are published', async () => {
	const auth = await adminHeaders(ctx, tenant);
	const response = await ctx.app.inject({
		method: 'GET',
		url: `/public/campaigns/${tenant.campaignSlug}/transparency`,
		headers: { 'x-internal-token': auth['x-internal-token']!, 'x-tenant-host': tenant.host }
	});
	expect(response.json().appUnitDraws.map((t: { sequence: number; entryNumber: string | null }) => [t.sequence, t.entryNumber])).toEqual([
		[1, null],
		[2, null]
	]);
	expect(response.body).not.toContain('***');
});
