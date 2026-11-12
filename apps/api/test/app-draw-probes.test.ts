import { randomUUID } from 'node:crypto';
import { count, eq, schema as s } from '@sortea/db';
import { sha256Hex } from '@sortea/domain/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminHeaders, createTenant, createTestContext, headers, openCampaign, placeOrder, webhookRequest, type TenantFixture, type TestContext } from './helpers';

/**
 * Verifier probes for ADR 0024 (T9, S10, L14): concurrent runs draw once, candidates are exactly
 * the eligible coupons of this campaign with no award, winners go before alternates, and the public
 * transparency never carries a masked name.
 */
let ctx: TestContext;
const twenty = () => Array.from({ length: 20 }, (_, index) => 1_000 + index);
const people = [
	['Juana', 'Pérez'],
	['Martín', 'Gómez'],
	['Lucía', 'Ñáñez']
] as const;

async function api(target: TenantFixture, method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: unknown, userId = target.operatorId) {
	return ctx.app.inject({ method, url, headers: await adminHeaders(ctx, target, userId), payload: payload as Record<string, unknown> | undefined });
}

async function setPrize(target: TenantFixture, kind: string, patch: Record<string, unknown>) {
	const { prizes } = (await api(target, 'GET', `/admin/campaigns/${target.campaignId}/prizes`, undefined, target.ownerId)).json() as { prizes: { id: string; kind: string }[] };
	const response = await api(target, 'PATCH', `/admin/prizes/${prizes.find((prize) => prize.kind === kind)!.id}`, patch, target.ownerId);
	expect(response.statusCode, response.body).toBe(200);
}

/** Cash (no alternates) then moto (one alternate), both Quiniela; the Quiniela matches nothing, so both are vacant. */
async function vacantTenant(label: string, orders: number) {
	const target = await createTenant(ctx, label);
	ctx.clock.now = new Date('2026-10-25T15:00:00Z');
	await setPrize(target, 'cash', { quantity: 1, alternatesCount: 0, position: 1, mechanism: 'quiniela' });
	await setPrize(target, 'vehicle', { alternatesCount: 1, position: 2, mechanism: 'quiniela' });
	await setPrize(target, 'product', { quantity: 1, alternatesCount: 0, position: 3 });
	await openCampaign(ctx, target);
	for (const [index, [firstName, lastName]] of people.slice(0, orders).entries()) {
		ctx.clock.now = new Date(ctx.clock.now.getTime() + 60_000);
		const order = await placeOrder(ctx, target, {
			buyer: { documentType: 'DNI', documentNumber: `30.000.00${index}`, firstName, lastName, email: `p${index}@example.com`, phone: `+54 9 11 5555-000${index}`, province: 'Salta', city: 'Cafayate' },
			consents: { terms: true, privacy: true, marketingEmail: false, winnerPublicity: true, adultDeclaration: true }
		});
		const payment = ctx.simulator.pay(order.checkoutId, 'approved');
		expect((await ctx.app.inject(webhookRequest(target, payment.id))).statusCode).toBe(200);
	}
	const campaign = `/admin/campaigns/${target.campaignId}`;
	ctx.clock.now = new Date('2026-11-29T01:00:00Z');
	expect((await api(target, 'POST', `${campaign}/close`, undefined, target.ownerId)).statusCode).toBe(200);
	expect((await api(target, 'POST', `${campaign}/transition`, { to: 'awarding' }, target.ownerId)).statusCode).toBe(200);
	ctx.clock.now = new Date('2026-11-30T12:00:00Z');
	const body = { source: 'Quiniela de la Ciudad, Nocturna', drawnAt: '2026-11-30T00:00:00Z', extracts: twenty(), evidenceUrl: 'https://loteria.example/extracto.pdf' };
	const previewed = await api(target, 'POST', `${campaign}/quiniela/preview`, body);
	expect(previewed.statusCode, previewed.body).toBe(200);
	expect((await api(target, 'POST', `${campaign}/quiniela`, { ...body, digest: previewed.json().digest })).statusCode).toBe(200);
	return target;
}

async function counts(target: TenantFixture) {
	return ctx.db.withTenant(target.id, async (tx) => {
		const [[awards], [draws], [events], [audits]] = await Promise.all([
			tx.select({ value: count() }).from(s.prizeAwards),
			tx.select({ value: count() }).from(s.appDraws),
			tx.select({ value: count() }).from(s.drawEvents).where(eq(s.drawEvents.kind, 'app_draw')),
			tx.select({ value: count() }).from(s.auditEvents).where(eq(s.auditEvents.action, 'award.app_draw_recorded'))
		]);
		return { awards: awards!.value, draws: draws!.value, events: events!.value, audits: audits!.value };
	});
}

beforeAll(async () => {
	ctx = await createTestContext();
});
afterAll(() => ctx.close());

describe('in-app draw probes', () => {
	let target: TenantFixture;

	it('excludes a voided coupon and the coupons of another campaign of the same organization', async () => {
		target = await vacantTenant('probe-draw', 3);
		// A refund after the close voids coupon 0005 (as payments/confirm.ts voidEntries does).
		await ctx.db.withTenant(target.id, (tx) =>
			tx.update(s.participationEntries).set({ status: 'void' }).where(eq(s.participationEntries.entryNumber, 5))
		);
		// Another campaign of the same organization holds coupon 0007.
		await ctx.db.withTenant(target.id, async (tx) => {
			const [campaign] = await tx.select().from(s.campaigns).where(eq(s.campaigns.id, target.campaignId));
			const otherId = randomUUID();
			await tx.insert(s.campaigns).values({ ...campaign!, id: otherId, slug: `other-${otherId.slice(0, 8)}` });
			const [entry] = await tx.select().from(s.participationEntries).where(eq(s.participationEntries.campaignId, target.campaignId)).limit(1);
			await tx.insert(s.participationEntries).values({ ...entry!, id: randomUUID(), campaignId: otherId, entryNumber: 7, status: 'eligible' });
		});
		const preview = await api(target, 'GET', `/admin/campaigns/${target.campaignId}/app-draw/preview`);
		expect(preview.statusCode, preview.body).toBe(200);
		expect(preview.json().candidates.map((candidate: { entryNumber: string }) => candidate.entryNumber)).toEqual(['0000', '0001', '0002', '0003', '0004']);
		expect(preview.json().candidateSha256).toBe(sha256Hex('0000\n0001\n0002\n0003\n0004'));
		expect(preview.json().vacant.map((unit: { prizeTitle: string }) => unit.prizeTitle)).toEqual(['$100.000', 'Moto']);
	});

	it('draws once under concurrent runs: one 201, the rest 200 with the same body, one record', async () => {
		const before = await counts(target);
		const responses = await Promise.all(Array.from({ length: 5 }, () => api(target, 'POST', `/admin/campaigns/${target.campaignId}/app-draw`)));
		expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 200, 200, 200, 201]);
		const bodies = responses.map((response) => response.json());
		for (const body of bodies) expect(body).toEqual(bodies[0]);
		expect(await counts(target)).toEqual({ awards: before.awards + 3, draws: 1, events: 1, audits: 1 });

		const drawn = bodies[0] as { candidateSha256: string; picks: { prizeTitle: string; role: string; rank: number; entryNumber: string }[] };
		expect(drawn.candidateSha256).toBe(sha256Hex('0000\n0001\n0002\n0003\n0004'));
		// Winners of every vacant unit first, in prize order, then the alternates.
		expect(drawn.picks.map((pick) => [pick.prizeTitle, pick.role, pick.rank])).toEqual([
			['$100.000', 'winner', 1],
			['Moto', 'winner', 1],
			['Moto', 'alternate', 1]
		]);
		const numbers = drawn.picks.map((pick) => pick.entryNumber);
		expect(new Set(numbers).size).toBe(3);
		for (const number of numbers) expect(['0000', '0001', '0002', '0003', '0004']).toContain(number);
	});

	it('keeps masked names out of the public transparency, before and after the results', async () => {
		const transparency = async () => (await ctx.app.inject({ method: 'GET', url: `/public/campaigns/${target.campaignSlug}/transparency`, headers: headers(target) })).json();
		const early = await transparency();
		expect(early.appDraws[0].picks).toBeNull();
		expect(JSON.stringify(early)).not.toContain('***');
		expect((await api(target, 'POST', `/admin/campaigns/${target.campaignId}/draw-events`, { kind: 'result_published', title: 'Resultados', occurredAt: ctx.clock.now.toISOString() })).statusCode).toBe(200);
		const published = JSON.stringify(await transparency());
		expect(published).not.toContain('***');
		for (const [first, last] of people) {
			expect(published).not.toContain(first);
			expect(published).not.toContain(last);
		}
	});

	it('with fewer coupons than seats, gives every unit a winner before any alternate', async () => {
		const small = await vacantTenant('probe-draw-small', 1);
		const response = await api(small, 'POST', `/admin/campaigns/${small.campaignId}/app-draw`);
		expect(response.statusCode, response.body).toBe(201);
		expect(response.json().picks.map((pick: { prizeTitle: string; role: string }) => [pick.prizeTitle, pick.role])).toEqual([
			['$100.000', 'winner'],
			['Moto', 'winner']
		]);
		const detail = (await api(small, 'GET', `/admin/campaigns/${small.campaignId}`, undefined, small.ownerId)).json();
		expect(detail).toMatchObject({ vacantSlots: [], appDraw: { state: 'drawn' } });
	});
});
