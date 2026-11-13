import { randomUUID } from 'node:crypto';
import { count, eq, schema as s } from '@sortea/db';
import { sha256Hex } from '@sortea/domain/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminHeaders, createTenant, createTestContext, headers, openCampaign, placeOrder, webhookRequest, type TenantFixture, type TestContext } from './helpers';

/**
 * Thousands of coupons (odd/tasks/owner-feedback-2026-11-11b.md T13, S12, L18):
 * the awards board and the campaign detail count the coupons in play instead of
 * listing them; the draw screen keeps the full list; transparency offers the
 * candidate list as a plain-text file whose SHA-256 is the published one; and a
 * vacant unit nobody can win any more is declared void with a reason, so the
 * campaign can finish.
 */
let ctx: TestContext;
const queries: string[] = [];
let recording = false;
const financeId = randomUUID();

const twenty = (...head: number[]) => [...head, ...Array.from({ length: 20 - head.length }, (_, index) => 1_000 + index)];
const people = ['Juana Pérez', 'Martín Gómez', 'Lucía Ñáñez'];

function client(target: TenantFixture) {
	const request = async (method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: unknown, userId = target.operatorId) =>
		ctx.app.inject({ method, url, headers: await adminHeaders(ctx, target, userId), payload: payload as Record<string, unknown> | undefined });
	const campaign = `/admin/campaigns/${target.campaignId}`;
	return {
		request,
		board: async () => (await request('GET', `${campaign}/awards`)).json(),
		detail: async () => (await request('GET', campaign, undefined, target.ownerId)).json(),
		preview: () => request('GET', `${campaign}/app-draw/preview`),
		run: () => request('POST', `${campaign}/app-draw`),
		result: () => request('GET', `${campaign}/app-draw`),
		record: (prizeId: string, slot: number, payload: unknown) => request('PUT', `${campaign}/awards/${prizeId}/slots/${slot}`, payload),
		declareVoid: (prizeId: string, slot: number, payload: unknown, userId?: string, campaignId = target.campaignId) =>
			request('POST', `/admin/campaigns/${campaignId}/awards/${prizeId}/slots/${slot}/void`, payload, userId),
		finish: () => request('POST', `${campaign}/transition`, { to: 'fulfilled' }, target.ownerId),
		event: (kind: string, title: string) => request('POST', `${campaign}/draw-events`, { kind, title, occurredAt: ctx.clock.now.toISOString() }),
		async quiniela(extracts: number[], drawnAt = '2026-11-30T00:00:00Z') {
			const body = { source: 'Quiniela de la Ciudad, Nocturna', drawnAt, extracts, evidenceUrl: 'https://loteria.example/extracto.pdf' };
			const previewed = await request('POST', `${campaign}/quiniela/preview`, body);
			expect(previewed.statusCode, previewed.body).toBe(200);
			const confirmed = await request('POST', `${campaign}/quiniela`, { ...body, digest: previewed.json().digest });
			expect(confirmed.statusCode, confirmed.body).toBe(200);
			return { previewed: previewed.json(), confirmed };
		},
		async toAwarding(closeAt = '2026-11-29T01:00:00Z', after = '2026-11-30T12:00:00Z') {
			ctx.clock.now = new Date(closeAt);
			const closed = await request('POST', `${campaign}/close`, undefined, target.ownerId);
			expect(closed.statusCode, closed.body).toBe(200);
			expect((await request('POST', `${campaign}/transition`, { to: 'awarding' }, target.ownerId)).statusCode).toBe(200);
			ctx.clock.now = new Date(after);
		},
		publicCampaign: async () => (await ctx.app.inject({ method: 'GET', url: `/public/campaigns/${target.campaignSlug}`, headers: headers(target) })).json(),
		transparency: async (target2 = target) => (await ctx.app.inject({ method: 'GET', url: `/public/campaigns/${target.campaignSlug}/transparency`, headers: headers(target2) })).json(),
		candidatesFile: (round: number | string, host = target, slug = target.campaignSlug) =>
			ctx.app.inject({ method: 'GET', url: `/public/campaigns/${slug}/app-draws/${round}/candidates.txt`, headers: headers(host) })
	};
}

async function setPrize(target: TenantFixture, kind: string, patch: Record<string, unknown>) {
	const auth = await adminHeaders(ctx, target);
	const { prizes } = (await ctx.app.inject({ method: 'GET', url: `/admin/campaigns/${target.campaignId}/prizes`, headers: auth })).json() as { prizes: { id: string; kind: string }[] };
	const response = await ctx.app.inject({ method: 'PATCH', url: `/admin/prizes/${prizes.find((prize) => prize.kind === kind)!.id}`, headers: auth, payload: patch });
	expect(response.statusCode, response.body).toBe(200);
}

/** `orders` purchases of two coupons each, every prize from the Quiniela: cash (`cash` units), then the moto with one alternate, then the kit. */
async function drawTenant(label: string, orders: number, cash = 1) {
	const target = await createTenant(ctx, label);
	ctx.clock.now = new Date('2026-10-25T15:00:00Z');
	await setPrize(target, 'cash', { quantity: cash, alternatesCount: 0, position: 1, mechanism: 'quiniela' });
	await setPrize(target, 'vehicle', { alternatesCount: 1, position: 2, mechanism: 'quiniela' });
	await setPrize(target, 'product', { quantity: 1, alternatesCount: 0, position: 3, mechanism: 'quiniela' });
	await openCampaign(ctx, target);
	for (const [index, name] of people.slice(0, orders).entries()) {
		ctx.clock.now = new Date(ctx.clock.now.getTime() + 60_000);
		const [firstName, lastName] = name.split(' ');
		const order = await placeOrder(ctx, target, {
			buyer: { documentType: 'DNI', documentNumber: `30.000.00${index}`, firstName, lastName, email: `buyer${index}@example.com`, phone: `+54 9 11 5555-000${index}`, province: 'Salta', city: 'Cafayate' },
			consents: { terms: true, privacy: true, marketingEmail: false, winnerPublicity: true, adultDeclaration: true }
		});
		const payment = ctx.simulator.pay(order.checkoutId, 'approved');
		expect((await ctx.app.inject(webhookRequest(target, payment.id))).statusCode).toBe(200);
	}
	return target;
}

/** `orders` more purchases of two coupons each, numbered from `from` so documents never repeat. */
async function buy(target: TenantFixture, orders: number, from: number) {
	for (let index = from; index < from + orders; index++) {
		ctx.clock.now = new Date(ctx.clock.now.getTime() + 60_000);
		const order = await placeOrder(ctx, target, {
			buyer: { documentType: 'DNI', documentNumber: String(33_000_000 + index), firstName: `Persona${index}`, lastName: 'Prueba', email: `ronda${index}@example.com`, phone: '+54 9 11 2345-6789', province: 'Salta', city: 'Salta' }
		});
		const payment = ctx.simulator.pay(order.checkoutId, 'approved');
		expect((await ctx.app.inject(webhookRequest(target, payment.id))).statusCode).toBe(200);
	}
}

type BoardSlot = { state: string; canDeclareVoid: boolean; void: { reason: string; declaredAt: string } | null; awards: { id: string }[] };
const slotOf = (board: { prizes: { kind: string; slots: unknown[] }[] }, kind: string, slot: number) => board.prizes.find((prize) => prize.kind === kind)!.slots[slot - 1] as BoardSlot;
const prizeIdsOf = (board: { prizes: { kind: string; id: string }[] }) => Object.fromEntries(board.prizes.map((prize) => [prize.kind, prize.id])) as Record<string, string>;

/** The queries that list a campaign's coupons one row each, as building the candidate list does. */
const couponListings = () => queries.filter((query) => /\bfrom "app"\."participation_entries"/i.test(query) && !/^select count\(/i.test(query.trim()));

async function recorded<T>(run: () => Promise<T>): Promise<T> {
	queries.length = 0;
	recording = true;
	try {
		return await run();
	} finally {
		recording = false;
	}
}

/** Everything a refused declaration must leave alone. */
async function footprint(target: TenantFixture) {
	return ctx.db.withTenant(target.id, async (tx) => {
		const [[voids], [awards], [events], [audits]] = await Promise.all([
			tx.select({ value: count() }).from(s.prizeSlotVoids),
			tx.select({ value: count() }).from(s.prizeAwards),
			tx.select({ value: count() }).from(s.drawEvents),
			tx.select({ value: count() }).from(s.auditEvents)
		]);
		return { voids: voids!.value, awards: awards!.value, events: events!.value, audits: audits!.value };
	});
}

beforeAll(async () => {
	ctx = await createTestContext({ onQuery: (query) => recording && queries.push(query) });
});
afterAll(() => ctx.close());

describe('the awards board and the campaign detail count instead of listing', () => {
	let tenant: TenantFixture;

	beforeAll(async () => {
		tenant = await drawTenant('scale-board', 3);
		const api = client(tenant);
		await api.toAwarding();
		// Coupon 0002 wins the cash prize; the moto and the kit stay vacant among 5 coupons without a prize.
		await api.quiniela(twenty(2));
	});

	it('answers the in-app draw state and the coupon count without loading a coupon list', async () => {
		const api = client(tenant);
		const board = await recorded(() => api.board());
		expect(board.appDraw).toEqual({ state: 'ready', round: 1, drawnAt: null, reason: null, candidateCount: 5 });
		expect(couponListings()).toEqual([]);

		const detail = await recorded(() => api.detail());
		expect(detail.appDraw).toEqual({ state: 'ready', round: 1, drawnAt: null, reason: null, candidateCount: 5 });
		expect(detail.vacantSlots).toEqual([
			{ prize: 'Moto', slot: 1 },
			{ prize: 'Kit', slot: 1 }
		]);
		expect(couponListings()).toEqual([]);
	});

	it('keeps the full masked list on the draw screen', async () => {
		const api = client(tenant);
		const response = await recorded(() => api.preview());
		expect(response.statusCode, response.body).toBe(200);
		expect(response.json().candidates.map((candidate: { entryNumber: string }) => candidate.entryNumber)).toEqual(['0000', '0001', '0003', '0004', '0005']);
		// The recorder sees the listing the preview needs: the board's empty result above is not a blind spot.
		expect(couponListings().length).toBeGreaterThan(0);

		const ran = await api.run();
		expect(ran.statusCode, ran.body).toBe(201);
		const result = await api.result();
		expect(result.json().candidates).toHaveLength(5);
		const board = await recorded(() => api.board());
		expect(board.appDraw).toEqual({ state: 'drawn', round: 1, drawnAt: ran.json().drawnAt, reason: null, candidateCount: 5 });
		expect(couponListings()).toEqual([]);
	});

	it('publishes the candidate list as a plain-text file whose SHA-256 is the published one, not inline', async () => {
		const api = client(tenant);
		const transparency = await api.transparency();
		const [draw] = transparency.appDraws;
		expect(draw).not.toHaveProperty('candidates');
		expect(draw).toMatchObject({ round: 1, candidateCount: 5 });

		const file = await api.candidatesFile(1);
		expect(file.statusCode, file.body).toBe(200);
		expect(file.headers['content-type']).toBe('text/plain; charset=utf-8');
		expect(file.headers['cache-control']).toMatch(/^public, max-age=\d+/);
		expect(file.headers['x-content-sha256']).toBe(draw.candidateSha256);
		expect(file.rawPayload.toString('utf8')).toBe('0000\n0001\n0003\n0004\n0005');
		// What `sha256sum` computes over the downloaded bytes.
		expect(sha256Hex(file.rawPayload.toString('utf8'))).toBe(draw.candidateSha256);
		expect(sha256Hex('0000\n0001\n0003\n0004\n0005')).toBe(draw.candidateSha256);
		for (const name of people) expect(file.body).not.toContain(name.split(' ')[0]);
	});

	it('answers 404 for a round without an in-app draw, another organization and an unknown campaign', async () => {
		const api = client(tenant);
		const other = await createTenant(ctx, 'scale-board-other');
		for (const response of [await api.candidatesFile(2), await api.candidatesFile(1, other), await api.candidatesFile(1, tenant, 'no-such-campaign')]) {
			expect(response.statusCode).toBe(404);
		}
		expect((await api.candidatesFile('uno')).statusCode).toBe(400);
		expect((await api.candidatesFile(0)).statusCode).toBe(400);
	});

	it('stops serving the file once the campaign is no longer public', async () => {
		const api = client(tenant);
		expect((await api.candidatesFile(1)).statusCode).toBe(200);
		await ctx.db.withTenant(tenant.id, (tx) => tx.update(s.campaigns).set({ status: 'draft', opensAt: null, closesAt: null }).where(eq(s.campaigns.id, tenant.campaignId)));
		expect((await api.candidatesFile(1)).statusCode).toBe(404);
	});
});

describe('declaring a unit void', () => {
	let tenant: TenantFixture;
	const prizeIds: Record<string, string> = {};

	beforeAll(async () => {
		// Two coupons for five units: three of cash, the moto and the kit.
		tenant = await drawTenant('scale-void', 1, 3);
		const api = client(tenant);
		await api.toAwarding();
		await api.quiniela(twenty());
		for (const prize of (await api.board()).prizes) prizeIds[prize.kind] = prize.id;
		await ctx.db.withPlatform((db) => db.insert(s.organizationMembers).values({ organizationId: tenant.id, userId: financeId, email: `finance@${tenant.host}`, role: 'finance_manager' }));
	});

	it('refuses while the in-app draw can still give the unit a winner, and finishing says to draw it', async () => {
		const api = client(tenant);
		const board = await api.board();
		expect(slotOf(board, 'cash', 1)).toMatchObject({ state: 'vacant', canDeclareVoid: false, void: null });
		const before = await footprint(tenant);
		const refused = await api.declareVoid(prizeIds.cash!, 1, { reason: 'No quedan cupones' });
		expect(refused.statusCode).toBe(409);
		expect(refused.json().error).toMatchObject({ code: 'app_draw_possible', message: 'Todavía hay cupones sin premio: sorteá la unidad en la aplicación antes de declararla desierta' });
		const finish = await api.finish();
		expect(finish.statusCode).toBe(409);
		expect(finish.json().error).toMatchObject({ code: 'prizes_vacant', message: 'Hay premios vacantes: sortealos en la aplicación' });
		expect(await footprint(tenant)).toEqual(before);
	});

	it('after the in-app draw ran out of coupons, finishing points to declaring the rest void', async () => {
		const api = client(tenant);
		const ran = await api.run();
		expect(ran.statusCode, ran.body).toBe(201);
		expect(ran.json().picks.map(({ prizeTitle, slot, role }: { prizeTitle: string; slot: number; role: string }) => [prizeTitle, slot, role])).toEqual([
			['$100.000', 1, 'winner'],
			['$100.000', 2, 'winner']
		]);
		const board = await api.board();
		expect(slotOf(board, 'cash', 1)).toMatchObject({ state: 'verifying', canDeclareVoid: false });
		for (const [kind, slot] of [['cash', 3], ['vehicle', 1], ['product', 1]] as const) expect(slotOf(board, kind, slot)).toMatchObject({ state: 'vacant', canDeclareVoid: true, void: null });

		const finish = await api.finish();
		expect(finish.statusCode).toBe(409);
		expect(finish.json().error).toMatchObject({
			code: 'prizes_vacant',
			message: 'Hay premios vacantes sin cupones para sortear: declaralos desiertos con «Declarar desierto» en Premios y entregas'
		});
		expect((await api.detail()).appDraw).toMatchObject({ state: 'drawn' });
	});

	it('needs a reason, the permission that records results, a unit nobody holds, and stays inside the organization', async () => {
		const api = client(tenant);
		const before = await footprint(tenant);
		const missing = await api.declareVoid(prizeIds.vehicle!, 1, { reason: ' no ' });
		expect(missing.statusCode).toBe(400);
		expect(missing.json().error.message).toBe('Explicá por qué la unidad queda desierta');
		expect((await api.declareVoid(prizeIds.vehicle!, 1, {})).statusCode).toBe(400);
		expect((await api.declareVoid(prizeIds.vehicle!, 1, { reason: 'Sin cupones para sortear' }, financeId)).statusCode).toBe(403);
		const held = await api.declareVoid(prizeIds.cash!, 1, { reason: 'Sin cupones para sortear' });
		expect(held.statusCode).toBe(409);
		expect(held.json().error).toMatchObject({ code: 'slot_not_voidable', message: 'Solo se declara desierta una unidad vacante sin cupones para sortear o una sin suplentes disponibles' });
		expect((await api.declareVoid(prizeIds.vehicle!, 2, { reason: 'Sin cupones para sortear' })).statusCode).toBe(400);
		const other = await createTenant(ctx, 'scale-void-other');
		expect((await client(other).declareVoid(prizeIds.vehicle!, 1, { reason: 'Sin cupones para sortear' }, other.ownerId, tenant.campaignId)).statusCode).toBe(404);
		expect(await footprint(tenant)).toEqual(before);
	});

	it('records the declaration once, with its reason, in the record and the audit', async () => {
		const api = client(tenant);
		const before = await footprint(tenant);
		const reason = 'Se vendieron menos cupones que premios: no quedan cupones para sortear';
		const declared = await api.declareVoid(prizeIds.vehicle!, 1, { reason });
		expect(declared.statusCode, declared.body).toBe(200);
		expect(slotOf(declared.json(), 'vehicle', 1)).toEqual({
			slot: 1,
			state: 'void',
			canRecord: false,
			canDeclareVoid: false,
			void: { reason, declaredAt: ctx.clock.now.toISOString() },
			awards: []
		});
		expect(await footprint(tenant)).toEqual({ ...before, voids: before.voids + 1, audits: before.audits + 1 });
		const [row] = await ctx.db.withTenant(tenant.id, (tx) => tx.select().from(s.prizeSlotVoids));
		expect(row).toMatchObject({ campaignId: tenant.campaignId, prizeId: prizeIds.vehicle, slot: 1, round: 1, reason, declaredBy: tenant.operatorId });
		const [auditRow] = await ctx.db.withTenant(tenant.id, (tx) => tx.select().from(s.auditEvents).where(eq(s.auditEvents.action, 'award.slot_declared_void')));
		expect(auditRow).toMatchObject({ actorId: tenant.operatorId, targetType: 'prize', targetId: prizeIds.vehicle, metadata: { slot: 1, round: 1, reason } });

		const again = await api.declareVoid(prizeIds.vehicle!, 1, { reason });
		expect(again.statusCode).toBe(409);
		expect(again.json().error).toMatchObject({ code: 'slot_already_void', message: 'Esta unidad ya fue declarada desierta' });
		expect(await footprint(tenant)).toEqual({ ...before, voids: before.voids + 1, audits: before.audits + 1 });
		expect((await api.detail()).vacantSlots).toEqual([
			{ prize: '$100.000', slot: 3 },
			{ prize: 'Kit', slot: 1 }
		]);
	});

	it('also takes a unit whose winner declined after the in-app draw, with no alternate left', async () => {
		const api = client(tenant);
		const winner = slotOf(await api.board(), 'cash', 2).awards[0]!;
		expect((await api.request('POST', `/admin/awards/${winner.id}/decision`, { decision: 'declined', notes: 'No respondió en el plazo' })).statusCode).toBe(200);
		expect(slotOf(await api.board(), 'cash', 2)).toMatchObject({ state: 'exhausted', canDeclareVoid: true });
		const declared = await api.declareVoid(prizeIds.cash!, 2, { reason: 'El ganador no reclamó y no hay suplentes' });
		expect(declared.statusCode, declared.body).toBe(200);
		expect(slotOf(declared.json(), 'cash', 2)).toMatchObject({ state: 'void', void: { reason: 'El ganador no reclamó y no hay suplentes' } });
	});

	it('shows the void units publicly with their reason once the results are out, and lets the campaign finish', async () => {
		const api = client(tenant);
		for (const [kind, slot] of [['cash', 3], ['product', 1]] as const) {
			expect((await api.declareVoid(prizeIds[kind]!, slot, { reason: 'No quedan cupones para sortear' })).statusCode).toBe(200);
		}
		expect((await api.transparency()).voidSlots).toEqual([]);
		expect((await api.event('result_published', 'Resultados')).statusCode).toBe(200);
		const transparency = await api.transparency();
		expect(transparency.vacantSlots).toEqual([]);
		expect(transparency.voidSlots).toEqual([
			{ round: 1, prize: '$100.000', slot: 2, reason: 'El ganador no reclamó y no hay suplentes', declaredAt: ctx.clock.now.toISOString() },
			{ round: 1, prize: '$100.000', slot: 3, reason: 'No quedan cupones para sortear', declaredAt: ctx.clock.now.toISOString() },
			{ round: 1, prize: 'Moto', slot: 1, reason: 'Se vendieron menos cupones que premios: no quedan cupones para sortear', declaredAt: ctx.clock.now.toISOString() },
			{ round: 1, prize: 'Kit', slot: 1, reason: 'No quedan cupones para sortear', declaredAt: ctx.clock.now.toISOString() }
		]);

		// The one winner left is delivered: nothing else blocks finishing.
		const winner = slotOf(await api.board(), 'cash', 1).awards[0]!;
		expect((await api.request('POST', `/admin/awards/${winner.id}/decision`, { decision: 'accepted' })).statusCode).toBe(200);
		expect((await api.request('PUT', `/admin/awards/${winner.id}/fulfillment`, { status: 'delivered' })).statusCode).toBe(200);
		const finished = await api.finish();
		expect(finished.statusCode, finished.body).toBe(200);
		expect(finished.json().status).toBe('fulfilled');
		expect((await api.request('POST', `/admin/campaigns/${tenant.campaignId}/transition`, { to: 'archived' }, tenant.ownerId)).statusCode).toBe(200);
	});
});

// Verifier findings on T13: a void unit is closed for good, every count matches the draw, and a declaration happens once.
describe('a void unit stays closed', () => {
	it('reopen leaves the void moto out, and the round 2 Quiniela never gives it a winner', async () => {
		const target = await drawTenant('v13-reopen', 1, 3);
		const api = client(target);
		await api.toAwarding();
		await api.quiniela(twenty());
		expect((await api.run()).statusCode).toBe(201);
		const ids = prizeIdsOf(await api.board());
		expect((await api.declareVoid(ids.vehicle!, 1, { reason: 'No quedan cupones para sortear' })).statusCode).toBe(200);
		expect((await api.event('result_published', 'Resultados')).statusCode).toBe(200);
		const reopened = await api.request('POST', `/admin/campaigns/${target.campaignId}/reopen`, { closesAt: '2026-12-20T23:00:00Z' }, target.ownerId);
		expect(reopened.statusCode, reopened.body).toBe(200);
		expect((await api.publicCampaign()).carriedOver).toEqual([
			{ prize: '$100.000', slot: 3 },
			{ prize: 'Kit', slot: 1 }
		]);
		ctx.clock.now = new Date('2026-12-01T12:00:00Z');
		await buy(target, 2, 10);
		await api.toAwarding('2026-12-21T00:00:00Z', '2026-12-22T12:00:00Z');
		const { previewed, confirmed } = await api.quiniela(twenty(2, 3, 4, 5), '2026-12-21T21:00:00Z');
		expect(confirmed.statusCode, confirmed.body).toBe(200);
		expect(previewed.slots.map((slot: { prizeTitle: string; slot: number }) => `${slot.prizeTitle}#${slot.slot}`)).not.toContain('Moto#1');
		const board = await api.board();
		expect(slotOf(board, 'vehicle', 1)).toMatchObject({ state: 'void', awards: [] });
		expect(slotOf(board, 'cash', 3).awards).toHaveLength(1);
		expect(slotOf(board, 'product', 1).awards).toHaveLength(1);
	});

	it('counts on the board and the detail exactly the coupons the draw would list', async () => {
		const target = await drawTenant('v13-count', 3);
		const api = client(target);
		await api.toAwarding();
		// Coupon 0002 wins the cash prize and declines it: it still holds an award.
		await api.quiniela(twenty(2));
		const winner = slotOf(await api.board(), 'cash', 1).awards[0]!;
		expect((await api.request('POST', `/admin/awards/${winner.id}/decision`, { decision: 'declined', notes: 'No respondió en el plazo' })).statusCode).toBe(200);
		// A refund after the close voids 0005; another campaign of the organization holds 0007.
		await ctx.db.withTenant(target.id, async (tx) => {
			await tx.update(s.participationEntries).set({ status: 'void' }).where(eq(s.participationEntries.entryNumber, 5));
			const [campaign] = await tx.select().from(s.campaigns).where(eq(s.campaigns.id, target.campaignId));
			const otherId = randomUUID();
			await tx.insert(s.campaigns).values({ ...campaign!, id: otherId, slug: `other-${otherId.slice(0, 8)}` });
			const [entry] = await tx.select().from(s.participationEntries).where(eq(s.participationEntries.campaignId, target.campaignId)).limit(1);
			await tx.insert(s.participationEntries).values({ ...entry!, id: randomUUID(), campaignId: otherId, entryNumber: 7, status: 'eligible' });
		});
		const preview = await api.preview();
		expect(preview.statusCode, preview.body).toBe(200);
		const listed = preview.json().candidates.map((candidate: { entryNumber: string }) => candidate.entryNumber);
		expect(listed).toEqual(['0000', '0001', '0003', '0004']);
		expect((await api.board()).appDraw.candidateCount).toBe(listed.length);
		expect((await api.detail()).appDraw.candidateCount).toBe(listed.length);
	});

	it('takes a reason of 5 to 1000 characters, and five simultaneous declarations record one', async () => {
		const target = await drawTenant('v13-race', 1, 3);
		const api = client(target);
		await api.toAwarding();
		await api.quiniela(twenty());
		expect((await api.run()).statusCode).toBe(201);
		const ids = prizeIdsOf(await api.board());
		const before = await footprint(target);
		for (const reason of ['    abcd   ', 'x'.repeat(1001)]) {
			const refused = await api.declareVoid(ids.vehicle!, 1, { reason });
			expect(refused.statusCode).toBe(400);
			expect(refused.json().error.code).toBe('reason_required');
		}
		expect(await footprint(target)).toEqual(before);
		expect((await api.declareVoid(ids.product!, 1, { reason: 'x'.repeat(1000) })).statusCode).toBe(200);
		expect((await api.declareVoid(ids.cash!, 3, { reason: 'abcde' })).statusCode).toBe(200);

		const responses = await Promise.all(Array.from({ length: 5 }, () => api.declareVoid(ids.vehicle!, 1, { reason: 'No quedan cupones para sortear' })));
		expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409, 409, 409, 409]);
		for (const response of responses.filter((candidate) => candidate.statusCode === 409)) expect(response.json().error.code).toBe('slot_already_void');
		const rows = await ctx.db.withTenant(target.id, (tx) => tx.select().from(s.prizeSlotVoids).where(eq(s.prizeSlotVoids.prizeId, ids.vehicle!)));
		expect(rows).toHaveLength(1);
	});

	it('does not let a vacancy be declared void while a coupon parked on a manual result is freed afterwards', async () => {
		const target = await createTenant(ctx, 'v13b-park');
		ctx.clock.now = new Date('2026-10-25T15:00:00Z');
		await setPrize(target, 'cash', { quantity: 1, alternatesCount: 0, position: 1, mechanism: 'quiniela' });
		await setPrize(target, 'vehicle', { alternatesCount: 1, position: 2, mechanism: 'manual' });
		await setPrize(target, 'product', { quantity: 1, alternatesCount: 0, position: 3, mechanism: 'quiniela' });
		await openCampaign(ctx, target);
		ctx.clock.now = new Date(ctx.clock.now.getTime() + 60_000);
		const order = await placeOrder(ctx, target);
		expect((await ctx.app.inject(webhookRequest(target, ctx.simulator.pay(order.checkoutId, 'approved').id))).statusCode).toBe(200);
		const api = client(target);
		await api.toAwarding();
		await api.quiniela(twenty());
		expect((await api.event('mechanism_recorded', 'Sorteo por Quiniela y a mano')).statusCode).toBe(200);
		const ids = prizeIdsOf(await api.board());
		expect((await api.record(ids.vehicle!, 1, { winner: 0, alternates: [1] })).statusCode).toBe(200);
		const declared = await api.declareVoid(ids.cash!, 1, { reason: 'No quedan cupones para sortear' });
		const corrected = await api.record(ids.vehicle!, 1, { winner: 0, alternates: [] });
		const board = await api.board();
		expect(declared.statusCode === 200 && corrected.statusCode === 200 && board.appDraw.candidateCount > 0).toBe(false);
	});

	it('refuses the declaration while a manual result can be corrected, and takes it once that result is decided', async () => {
		const target = await createTenant(ctx, 'v13b-settle');
		ctx.clock.now = new Date('2026-10-25T15:00:00Z');
		await setPrize(target, 'cash', { quantity: 1, alternatesCount: 0, position: 1, mechanism: 'quiniela' });
		await setPrize(target, 'vehicle', { alternatesCount: 1, position: 2, mechanism: 'manual' });
		await setPrize(target, 'product', { quantity: 1, alternatesCount: 0, position: 3, mechanism: 'quiniela' });
		await openCampaign(ctx, target);
		ctx.clock.now = new Date(ctx.clock.now.getTime() + 60_000);
		const order = await placeOrder(ctx, target);
		expect((await ctx.app.inject(webhookRequest(target, ctx.simulator.pay(order.checkoutId, 'approved').id))).statusCode).toBe(200);
		const api = client(target);
		await api.toAwarding();
		await api.quiniela(twenty());
		expect((await api.event('mechanism_recorded', 'Sorteo por Quiniela y a mano')).statusCode).toBe(200);
		const ids = prizeIdsOf(await api.board());
		expect((await api.record(ids.vehicle!, 1, { winner: 0, alternates: [1] })).statusCode).toBe(200);
		const board = await api.board();
		expect(board.appDraw.candidateCount).toBe(0);
		expect(slotOf(board, 'cash', 1)).toMatchObject({ state: 'vacant', canDeclareVoid: false });
		expect(board.voidBlocked).toBe('Hay resultados cargados a mano que todavía se pueden corregir: decidí sobre sus ganadores antes de declarar desierta una unidad vacante');
		const before = await footprint(target);
		const refused = await api.declareVoid(ids.cash!, 1, { reason: 'No quedan cupones para sortear' });
		expect(refused.statusCode).toBe(409);
		expect(refused.json().error).toMatchObject({
			code: 'manual_results_open',
			message: 'Hay resultados cargados a mano que todavía se pueden corregir: decidí sobre sus ganadores antes de declarar desierta una unidad vacante'
		});
		expect(await footprint(target)).toEqual(before);

		// Deciding the manual winner freezes that result: the coupons can no longer come back.
		const winner = slotOf(board, 'vehicle', 1).awards[0]!;
		expect((await api.request('POST', `/admin/awards/${winner.id}/decision`, { decision: 'accepted' })).statusCode).toBe(200);
		const settled = await api.board();
		expect(slotOf(settled, 'cash', 1)).toMatchObject({ canDeclareVoid: true });
		expect(settled.voidBlocked).toBeNull();
		expect((await api.declareVoid(ids.cash!, 1, { reason: 'No quedan cupones para sortear' })).statusCode).toBe(200);
		expect((await api.record(ids.vehicle!, 1, { winner: 0, alternates: [] })).statusCode).toBe(409);
		expect((await api.board()).appDraw.candidateCount).toBe(0);
	});
});
