import { randomUUID } from 'node:crypto';
import { count, schema as s } from '@sortea/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminHeaders, createTenant, createTestContext, openCampaign, placeOrder, webhookRequest, type TenantFixture, type TestContext } from './helpers';

/**
 * odd/tasks/draw-room.md T5 (S4, L1 "Se confirma al final"): in the draw room
 * the host types each extract as it comes out, and the screen shows at once
 * which coupon it matches and which unit it takes. The preview therefore
 * accepts the first 1 to 20 extracts, with or without the draw's other data,
 * and writes nothing; only a complete preview carries the digest that the
 * record (still exactly 20 extracts) requires.
 */
let ctx: TestContext;
let tenant: TenantFixture;
const hostId = randomUUID();

/** Coupons 0000-0001 (Juana), 0002-0003 (Martín), 0004-0005 (Lucía). */
const buyers = [
	{ documentNumber: '30.111.222', firstName: 'Juana', lastName: 'Pérez', email: 'juana.perez@example.com' },
	{ documentNumber: '30.333.444', firstName: 'Martín', lastName: 'Gómez', email: 'martin.gomez@example.com' },
	{ documentNumber: '30.555.666', firstName: 'Lucía', lastName: 'Ñáñez', email: 'lucia.nanez@example.com' }
];
const twenty = (...head: number[]) => [...head, ...Array.from({ length: 20 - head.length }, (_, index) => 1_000 + index)];
const details = { source: 'Quiniela de la Ciudad, Nocturna', drawnAt: '2026-11-30T00:00:00Z', evidenceUrl: 'https://loteria.example/extracto.pdf' };

const as = async (userId: string, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) =>
	ctx.app.inject({ method, url, headers: await adminHeaders(ctx, tenant, userId), payload: payload as Record<string, unknown> | undefined });
const preview = (body: unknown, userId = hostId) => as(userId, 'POST', `/admin/campaigns/${tenant.campaignId}/quiniela/preview`, body);
const record = (body: unknown) => as(hostId, 'POST', `/admin/campaigns/${tenant.campaignId}/quiniela`, body);

async function setPrize(kind: string, patch: Record<string, unknown>) {
	const { prizes } = (await as(tenant.ownerId, 'GET', `/admin/campaigns/${tenant.campaignId}/prizes`)).json() as { prizes: { id: string; kind: string }[] };
	const response = await as(tenant.ownerId, 'PATCH', `/admin/prizes/${prizes.find((prize) => prize.kind === kind)!.id}`, patch);
	expect(response.statusCode, response.body).toBe(200);
}

async function footprint() {
	return ctx.db.withTenant(tenant.id, async (tx) => {
		const [[awards], [draws], [events], [audits]] = await Promise.all([
			tx.select({ value: count() }).from(s.prizeAwards),
			tx.select({ value: count() }).from(s.quinielaDraws),
			tx.select({ value: count() }).from(s.drawEvents),
			tx.select({ value: count() }).from(s.auditEvents)
		]);
		return { awards: awards!.value, draws: draws!.value, events: events!.value, audits: audits!.value };
	});
}

type Preview = {
	extracts: { position: number; number: number; outcome: string; prizeId: string | null; slot: number | null }[];
	slots: { prizeTitle: string; slot: number; winner: { entryNumber: number; extract: number } | null }[];
	holders: { entryNumber: number; maskedName: string }[];
	digest: string | null;
};

beforeAll(async () => {
	ctx = await createTestContext();
	tenant = await createTenant(ctx, 'partial');
	ctx.clock.now = new Date('2026-10-25T15:00:00Z');
	// The cash prize first (2 units), the moto last; awarded from the last prize to the first.
	await setPrize('cash', { quantity: 2, alternatesCount: 0, position: 1, mechanism: 'quiniela' });
	await setPrize('vehicle', { alternatesCount: 0, position: 2, mechanism: 'quiniela' });
	expect((await as(tenant.ownerId, 'PATCH', `/admin/campaigns/${tenant.campaignId}`, { awardOrder: 'last_to_first' })).statusCode).toBe(200);
	await openCampaign(ctx, tenant);
	for (const buyer of buyers) {
		ctx.clock.now = new Date(ctx.clock.now.getTime() + 60_000);
		const order = await placeOrder(ctx, tenant, {
			buyer: { documentType: 'DNI', documentNumber: buyer.documentNumber, firstName: buyer.firstName, lastName: buyer.lastName, email: buyer.email, phone: '+54 9 11 5555-0001', province: 'Salta', city: 'Salta' }
		});
		const payment = ctx.simulator.pay(order.checkoutId, 'approved');
		expect((await ctx.app.inject(webhookRequest(tenant, payment.id))).statusCode).toBe(200);
	}
	ctx.clock.now = new Date('2026-11-29T01:00:00Z');
	expect((await as(tenant.ownerId, 'POST', `/admin/campaigns/${tenant.campaignId}/close`)).statusCode).toBe(200);
	expect((await as(tenant.ownerId, 'POST', `/admin/campaigns/${tenant.campaignId}/transition`, { to: 'awarding' })).statusCode).toBe(200);
	ctx.clock.now = new Date('2026-11-30T12:00:00Z');
	await ctx.db.withPlatform((db) => db.insert(s.organizationMembers).values({ organizationId: tenant.id, userId: hostId, email: `host@${tenant.host}`, role: 'draw_host' }));
});
afterAll(() => ctx.close());

describe('a partial Quiniela preview (draw room T5)', () => {
	it('matches the extracts typed so far, in award order, with masked names, and writes nothing', async () => {
		const before = await footprint();
		const response = await preview({ extracts: [9_999, 4, 4] });
		expect(response.statusCode, response.body).toBe(200);
		const result = response.json() as Preview;
		expect(result.extracts.map((extract) => [extract.position, extract.number, extract.outcome])).toEqual([
			[1, 9_999, 'no_match'],
			[2, 4, 'winner'],
			[3, 4, 'repeated']
		]);
		// From the last prize to the first: the first match takes the moto.
		expect(result.slots.map((slot) => [slot.prizeTitle, slot.slot, slot.winner])).toEqual([
			['Moto', 1, { entryNumber: 4, extract: 2 }],
			['$100.000', 1, null],
			['$100.000', 2, null]
		]);
		// Only the masked name of whoever a match names: never the full name, the email or the document.
		expect(result.holders).toEqual([{ entryNumber: 4, maskedName: 'Lu*** Ñ.' }]);
		for (const value of ['Lucía', 'Ñáñez', 'lucia.nanez@example.com', '30.555.666']) expect(response.body).not.toContain(value);
		// Not complete: nothing to confirm yet.
		expect(result.digest).toBeNull();
		expect(await footprint()).toEqual(before);
	});

	it('gives each typed prefix the same outcomes as the complete draw', async () => {
		const extracts = twenty(9_999, 2, 0, 2, 5, 3);
		const full = (await preview({ ...details, extracts })).json() as Preview;
		expect(full.digest).toMatch(/^[0-9a-f]{64}$/);
		for (const typed of [1, 2, 3, 5, 6, 12, 19]) {
			const partial = (await preview({ extracts: extracts.slice(0, typed) })).json() as Preview;
			expect(partial.extracts, `${typed} extracts`).toEqual(full.extracts.slice(0, typed));
			expect(partial.digest, `${typed} extracts`).toBeNull();
		}
		// All 20 without the draw's data still has no digest: confirming needs them.
		expect(((await preview({ extracts })).json() as Preview).digest).toBeNull();
	});

	it('still validates what is given: 1 to 20 extracts of 4 digits, https evidence, the draw time', async () => {
		const before = await footprint();
		for (const body of [{ extracts: [] }, { extracts: [...twenty(), 1] }, { extracts: [10_000] }, { extracts: [1], evidenceUrl: 'http://loteria.example/x.pdf' }, { extracts: [1], source: 'Q' }, {}]) {
			const refused = await preview(body);
			expect(refused.statusCode, JSON.stringify(body)).toBe(400);
			expect(refused.json().error.code).toBe('invalid_request');
		}
		const early = await preview({ extracts: [1], drawnAt: '2026-11-29T00:30:00Z' });
		expect(early.json().error).toMatchObject({ code: 'draw_before_manifest', message: 'El sorteo de la Quiniela tiene que ser posterior a la publicación del manifiesto (28/11/2026 22:00)' });
		expect((await preview({ extracts: [1], drawnAt: '2026-11-30T12:00:01Z' })).json().error).toMatchObject({ code: 'draw_in_future', message: 'La fecha del sorteo no puede ser futura' });
		// Roles without draws.run or campaigns.operate are refused as before.
		const financeId = randomUUID();
		await ctx.db.withPlatform((db) => db.insert(s.organizationMembers).values({ organizationId: tenant.id, userId: financeId, email: `finance@${tenant.host}`, role: 'finance_manager' }));
		expect((await preview({ extracts: [1] }, financeId)).statusCode).toBe(403);
		expect(await footprint()).toEqual(before);
	});

	it('records only the 20 extracts with the digest of a complete preview', async () => {
		const extracts = twenty(9_999, 2, 0);
		const before = await footprint();
		const nineteen = await record({ ...details, extracts: extracts.slice(0, 19), digest: 'a'.repeat(64) });
		expect(nineteen.statusCode).toBe(400);
		expect(nineteen.json().error.code).toBe('invalid_request');
		expect((await record({ ...details, extracts, digest: null })).json().error.code).toBe('invalid_request');
		expect((await record({ ...details, extracts, digest: 'f'.repeat(64) })).json().error.code).toBe('preview_outdated');
		expect(await footprint()).toEqual(before);

		const { digest } = (await preview({ ...details, extracts })).json() as Preview;
		const recorded = await record({ ...details, extracts, digest });
		expect(recorded.statusCode, recorded.body).toBe(200);
		const room = recorded.json() as { winners: { prizeTitle: string; slot: number; entryNumber: string }[] };
		expect(room.winners.map((winner) => [winner.prizeTitle, winner.slot, winner.entryNumber])).toEqual([
			['$100.000', 1, '0000'],
			['Moto', 1, '0002']
		]);
		// Recorded: the round has its draw, so a new preview is refused as before.
		expect((await preview({ extracts: [1] })).json().error.code).toBe('draw_exists');
	});
});
