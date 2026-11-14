import { randomUUID } from 'node:crypto';
import { and, count, eq, schema as s } from '@sortea/db';
import { sha256Hex } from '@sortea/domain/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminHeaders, createTenant, createTestContext, headers, openCampaign, placeOrder, webhookRequest, type TenantFixture, type TestContext } from './helpers';

/**
 * odd/tasks/draw-room.md T3 (S4, S5), ADR 0024 as amended: the operator picks
 * one drawable prize unit and the platform draws ONE winner among the eligible
 * coupons holding no award, recording the tirada before answering. A unit whose
 * winner was passed over is drawn again; no alternates come from the app; the
 * one-shot run of every vacancy is no longer drawn, but a stored one stays readable.
 */
let ctx: TestContext;
const financeId = randomUUID();

interface Candidate {
	entryNumber: string;
	maskedName: string;
}
interface Tirada {
	round: number;
	sequence: number;
	attempt: number;
	prizeId: string;
	prizeTitle: string;
	slot: number;
	drawnAt: string;
	candidateCount: number;
	candidateSha256: string;
	pick: Candidate;
}
interface TiradaResult extends Tirada {
	campaign: { id: string; title: string; round: number; entryDigits: number; timezone: string };
	candidates: Candidate[];
}

const twenty = (...head: number[]) => [...head, ...Array.from({ length: 20 - head.length }, (_, index) => 1_000 + index)];

/** Three buyers, two coupons each: Juana 0000-0001, Martín 0002-0003, Lucía 0004-0005 (who does not consent to be named). */
const buyers = [
	{ documentNumber: '30.111.222', firstName: 'Juana', lastName: 'Pérez', email: 'juana.perez@example.com', publicity: true },
	{ documentNumber: '30.333.444', firstName: 'martín', lastName: 'Gómez', email: 'martin.gomez@example.com', publicity: true },
	{ documentNumber: '30.555.666', firstName: 'Lucía', lastName: 'Ñáñez', email: 'lucia.nanez@example.com', publicity: false },
	{ documentNumber: '30.777.888', firstName: 'Pedro', lastName: 'Ríos', email: 'pedro.rios@example.com', publicity: true }
];
const masked: Record<string, string> = { '0000': 'Ju*** P.', '0001': 'Ju*** P.', '0002': 'Ma*** G.', '0003': 'Ma*** G.', '0004': 'Lu*** Ñ.', '0005': 'Lu*** Ñ.' };

function client(target: TenantFixture) {
	const request = async (method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: unknown, userId = target.operatorId) =>
		ctx.app.inject({ method, url, headers: await adminHeaders(ctx, target, userId), payload: payload as Record<string, unknown> | undefined });
	const campaign = `/admin/campaigns/${target.campaignId}`;
	return {
		request,
		draw: (body: unknown, userId?: string, campaignId = target.campaignId) => request('POST', `/admin/campaigns/${campaignId}/app-draw/units`, body, userId),
		units: (userId?: string, campaignId = target.campaignId) => request('GET', `/admin/campaigns/${campaignId}/app-draw/units`, undefined, userId),
		replay: (sequence: number, userId?: string) => request('GET', `${campaign}/app-draw/units/${sequence}`, undefined, userId),
		board: async () => (await request('GET', `${campaign}/awards`)).json(),
		event: (kind: string, title: string) => request('POST', `${campaign}/draw-events`, { kind, title, occurredAt: ctx.clock.now.toISOString() }),
		async quiniela(extracts: number[]) {
			const body = { source: 'Quiniela de la Ciudad, Nocturna', drawnAt: '2026-11-30T00:00:00Z', extracts, evidenceUrl: 'https://loteria.example/extracto.pdf' };
			const previewed = await request('POST', `${campaign}/quiniela/preview`, body);
			expect(previewed.statusCode, previewed.body).toBe(200);
			const confirmed = await request('POST', `${campaign}/quiniela`, { ...body, digest: previewed.json().digest });
			expect(confirmed.statusCode, confirmed.body).toBe(200);
		},
		async toAwarding() {
			ctx.clock.now = new Date('2026-11-29T01:00:00Z');
			expect((await request('POST', `${campaign}/close`, undefined, target.ownerId)).statusCode).toBe(200);
			expect((await request('POST', `${campaign}/transition`, { to: 'awarding' }, target.ownerId)).statusCode).toBe(200);
			ctx.clock.now = new Date('2026-11-30T12:00:00Z');
		},
		transparency: async () => (await ctx.app.inject({ method: 'GET', url: `/public/campaigns/${target.campaignSlug}/transparency`, headers: headers(target) })).json(),
		file: (round: number, sequence: number) => ctx.app.inject({ method: 'GET', url: `/public/campaigns/${target.campaignSlug}/app-draws/${round}/units/${sequence}/candidates.txt`, headers: headers(target) })
	};
}

async function setPrize(target: TenantFixture, kind: string, patch: Record<string, unknown>) {
	const auth = await adminHeaders(ctx, target);
	const { prizes } = (await ctx.app.inject({ method: 'GET', url: `/admin/campaigns/${target.campaignId}/prizes`, headers: auth })).json() as { prizes: { id: string; kind: string }[] };
	const response = await ctx.app.inject({ method: 'PATCH', url: `/admin/prizes/${prizes.find((prize) => prize.kind === kind)!.id}`, headers: auth, payload: patch });
	expect(response.statusCode, response.body).toBe(200);
}

/** Two cash units then the moto, both from the Quiniela and with no alternates; the kit is recorded by hand. */
async function unitsTenant(label: string, orders: number) {
	const target = await createTenant(ctx, label);
	ctx.clock.now = new Date('2026-10-25T15:00:00Z');
	await setPrize(target, 'cash', { quantity: 2, alternatesCount: 0, position: 1, mechanism: 'quiniela' });
	await setPrize(target, 'vehicle', { alternatesCount: 0, position: 2, mechanism: 'quiniela' });
	await setPrize(target, 'product', { quantity: 1, alternatesCount: 0, position: 3 });
	await openCampaign(ctx, target);
	for (const [index, buyer] of buyers.slice(0, orders).entries()) {
		ctx.clock.now = new Date(ctx.clock.now.getTime() + 60_000);
		const order = await placeOrder(ctx, target, {
			buyer: { documentType: 'DNI', documentNumber: buyer.documentNumber, firstName: buyer.firstName, lastName: buyer.lastName, email: buyer.email, phone: `+54 9 11 5555-000${index}`, province: 'Salta', city: 'Cafayate' },
			consents: { terms: true, privacy: true, marketingEmail: false, winnerPublicity: buyer.publicity, adultDeclaration: true }
		});
		const payment = ctx.simulator.pay(order.checkoutId, 'approved');
		expect((await ctx.app.inject(webhookRequest(target, payment.id))).statusCode).toBe(200);
	}
	return target;
}

async function prizeIds(target: TenantFixture) {
	const rows = await ctx.db.withTenant(target.id, (tx) => tx.select({ id: s.prizes.id, kind: s.prizes.kind }).from(s.prizes).where(eq(s.prizes.campaignId, target.campaignId)));
	const of = (kind: string) => rows.find((row) => row.kind === kind)!.id;
	return { cash: of('cash'), moto: of('vehicle'), kit: of('product') };
}

/** Everything a refused or repeated tirada must leave alone. */
async function footprint(target: TenantFixture) {
	return ctx.db.withTenant(target.id, async (tx) => {
		const [[awards], [tiradas], [oneShot], [events], [audits]] = await Promise.all([
			tx.select({ value: count() }).from(s.prizeAwards),
			tx.select({ value: count() }).from(s.appUnitDraws),
			tx.select({ value: count() }).from(s.appDraws),
			tx.select({ value: count() }).from(s.drawEvents),
			tx.select({ value: count() }).from(s.auditEvents)
		]);
		return { awards: awards!.value, tiradas: tiradas!.value, oneShot: oneShot!.value, events: events!.value, audits: audits!.value };
	});
}

/** Nothing a buyer typed except the masked first two letters and initial. */
function expectNoPersonalData(body: string) {
	for (const buyer of buyers) {
		for (const value of [buyer.documentNumber, buyer.email, buyer.lastName, buyer.firstName, 'Cafayate', '5555-000']) expect(body, value).not.toContain(value);
	}
}

function expectRefusal(response: { statusCode: number; json: () => { error: { code: string; message: string } } }, status: number, code: string, message?: string) {
	expect(response.statusCode).toBe(status);
	expect(response.json().error).toMatchObject(message ? { code, message } : { code });
}

beforeAll(async () => {
	ctx = await createTestContext();
});
afterAll(() => ctx.close());

describe('a tirada per prize unit', () => {
	let tenant: TenantFixture;
	let other: TenantFixture;
	let ids: Awaited<ReturnType<typeof prizeIds>>;
	let motoTirada: TiradaResult;
	let cashTirada: TiradaResult;

	beforeAll(async () => {
		// Another organization with more coupons (0000-0007): a leak would add 0006 and 0007.
		other = await unitsTenant('units-other', 4);
		tenant = await unitsTenant('units', 3);
		ids = await prizeIds(tenant);
		await ctx.db.withPlatform((db) => db.insert(s.organizationMembers).values({ organizationId: tenant.id, userId: financeId, email: `finance@${tenant.host}`, role: 'finance_manager' }));
		// Another campaign of the same organization holds coupon 0009.
		await ctx.db.withTenant(tenant.id, async (tx) => {
			const [campaign] = await tx.select().from(s.campaigns).where(eq(s.campaigns.id, tenant.campaignId));
			const otherId = randomUUID();
			await tx.insert(s.campaigns).values({ ...campaign!, id: otherId, slug: `other-${otherId.slice(0, 8)}` });
			const [entry] = await tx.select().from(s.participationEntries).where(eq(s.participationEntries.campaignId, tenant.campaignId)).limit(1);
			await tx.insert(s.participationEntries).values({ ...entry!, id: randomUUID(), campaignId: otherId, entryNumber: 9, status: 'eligible' });
		});
	});

	it('refuses before the campaign is awarding and before the round Quiniela, writing nothing', async () => {
		const api = client(tenant);
		const before = await footprint(tenant);
		expectRefusal(await api.draw({ prizeId: ids.moto, slot: 1 }), 409, 'not_awarding', 'Las adjudicaciones se registran con la campaña en adjudicación, después de publicar el manifiesto');
		const early = await api.units();
		expect(early.statusCode, early.body).toBe(200);
		expect(early.json()).toMatchObject({ tiradas: [], units: [], candidateCount: null, reason: 'Las adjudicaciones se registran con la campaña en adjudicación, después de publicar el manifiesto' });

		await api.toAwarding();
		const awarding = await footprint(tenant);
		expectRefusal(await api.draw({ prizeId: ids.moto, slot: 1 }), 409, 'quiniela_draw_required', 'Primero registrá el resultado de la Quiniela de esta ronda');
		expect((await api.units()).json()).toMatchObject({ units: [], reason: 'Primero registrá el resultado de la Quiniela de esta ronda' });
		expect(await footprint(tenant)).toEqual(awarding);
		expect(awarding.tiradas).toBe(before.tiradas);
	});

	it('lists the drawable units once the Quiniela left them vacant, with the coupons in play counted', async () => {
		const api = client(tenant);
		// Coupon 0002 wins the first cash unit; the second one and the moto stay vacant.
		await api.quiniela(twenty(2));
		// A refund after the close voids coupon 0005 (as payments/confirm.ts voidEntries does).
		await ctx.db.withTenant(tenant.id, (tx) =>
			tx.update(s.participationEntries).set({ status: 'void' }).where(and(eq(s.participationEntries.campaignId, tenant.campaignId), eq(s.participationEntries.entryNumber, 5)))
		);
		const response = await api.units();
		expect(response.statusCode, response.body).toBe(200);
		expect(response.json()).toEqual({
			campaign: { id: tenant.campaignId, title: 'Moto 0 km', round: 1, entryDigits: 4, timezone: 'America/Argentina/Buenos_Aires' },
			tiradas: [],
			units: [
				{ prizeId: ids.cash, prizeTitle: '$100.000', slot: 2, state: 'vacant' },
				{ prizeId: ids.moto, prizeTitle: 'Moto', slot: 1, state: 'vacant' }
			],
			candidateCount: 4,
			reason: null
		});
	});

	it('needs the permission that records results, and stays inside the organization', async () => {
		const api = client(tenant);
		const before = await footprint(tenant);
		expect((await api.draw({ prizeId: ids.moto, slot: 1 }, financeId)).statusCode).toBe(403);
		expect((await api.units(financeId)).statusCode).toBe(403);
		const outsider = client(other);
		expect((await outsider.draw({ prizeId: ids.moto, slot: 1 }, other.ownerId, tenant.campaignId)).statusCode).toBe(404);
		expect((await outsider.units(other.ownerId, tenant.campaignId)).statusCode).toBe(404);
		expect(await footprint(tenant)).toEqual(before);
	});

	it('refuses a unit it cannot draw, saying why, and writes nothing', async () => {
		const api = client(tenant);
		const before = await footprint(tenant);
		expect((await api.draw({ prizeId: 'not-a-uuid', slot: 1 })).statusCode).toBe(400);
		expect((await api.draw({ prizeId: ids.moto, slot: 0 })).statusCode).toBe(400);
		expect((await api.draw({ prizeId: ids.moto })).statusCode).toBe(400);
		expectRefusal(await api.draw({ prizeId: randomUUID(), slot: 1 }), 404, 'not_found');
		expectRefusal(await api.draw({ prizeId: ids.moto, slot: 2 }), 400, 'invalid_slot', 'Ese premio no tiene tantas unidades');
		expectRefusal(await api.draw({ prizeId: ids.kit, slot: 1 }), 409, 'unit_not_drawable', 'Este premio se carga a mano: no se sortea en la aplicación');
		expectRefusal(await api.draw({ prizeId: ids.cash, slot: 1 }), 409, 'unit_has_winner', 'Esta unidad ya tiene ganador: no se vuelve a sortear');
		// Another organization's prize is not found either.
		const foreign = await prizeIds(other);
		expectRefusal(await api.draw({ prizeId: foreign.moto, slot: 1 }), 404, 'not_found');
		expect(await footprint(tenant)).toEqual(before);
	});

	it('draws one winner for the moto among the eligible coupons of this campaign with no award, and stores tirada, award, log and audit together', async () => {
		const api = client(tenant);
		const before = await footprint(tenant);
		const response = await api.draw({ prizeId: ids.moto, slot: 1 });
		expect(response.statusCode, response.body).toBe(201);
		motoTirada = response.json();
		expectNoPersonalData(response.body);
		const candidates = ['0000', '0001', '0003', '0004'];
		expect(motoTirada).toMatchObject({
			campaign: { id: tenant.campaignId, title: 'Moto 0 km', round: 1, entryDigits: 4, timezone: 'America/Argentina/Buenos_Aires' },
			round: 1,
			sequence: 1,
			attempt: 1,
			prizeId: ids.moto,
			prizeTitle: 'Moto',
			slot: 1,
			drawnAt: ctx.clock.now.toISOString(),
			candidateCount: 4,
			candidateSha256: sha256Hex(candidates.join('\n'))
		});
		expect(motoTirada.candidates).toEqual(candidates.map((entryNumber) => ({ entryNumber, maskedName: masked[entryNumber] })));
		expect(candidates).toContain(motoTirada.pick.entryNumber);
		expect(motoTirada.pick.maskedName).toBe(masked[motoTirada.pick.entryNumber]);

		expect(await footprint(tenant)).toEqual({ ...before, awards: before.awards + 1, tiradas: 1, events: before.events + 1, audits: before.audits + 1 });
		const [record] = await ctx.db.withTenant(tenant.id, (tx) => tx.select().from(s.appUnitDraws));
		expect(record).toMatchObject({
			organizationId: tenant.id,
			campaignId: tenant.campaignId,
			round: 1,
			sequence: 1,
			prizeId: ids.moto,
			slot: 1,
			attempt: 1,
			candidateCount: 4,
			candidates: [0, 1, 3, 4],
			candidateSha256: motoTirada.candidateSha256,
			entryNumber: Number(motoTirada.pick.entryNumber),
			recordedBy: tenant.operatorId
		});
		const awards = await ctx.db.withTenant(tenant.id, (tx) =>
			tx
				.select({ role: s.prizeAwards.role, rank: s.prizeAwards.rank, slot: s.prizeAwards.slot, round: s.prizeAwards.round, entryNumber: s.participationEntries.entryNumber, notes: s.prizeAwards.notes, status: s.prizeAwards.status, appDrawId: s.prizeAwards.appDrawId })
				.from(s.prizeAwards)
				.innerJoin(s.participationEntries, eq(s.participationEntries.id, s.prizeAwards.entryId))
				.where(eq(s.prizeAwards.appUnitDrawId, record!.id))
		);
		expect(awards).toEqual([{ role: 'winner', rank: 1, slot: 1, round: 1, entryNumber: record!.entryNumber, notes: 'Sorteo en la app', status: 'pending_verification', appDrawId: null }]);

		const [event] = await ctx.db.withTenant(tenant.id, (tx) => tx.select().from(s.drawEvents).where(eq(s.drawEvents.kind, 'app_draw')));
		expect(event).toMatchObject({ round: 1, title: 'Sorteo en la app: Moto', detail: 'Entre 4 cupones sin premio.', recordedBy: tenant.operatorId });
		const [auditRow] = await ctx.db.withTenant(tenant.id, (tx) => tx.select().from(s.auditEvents).where(eq(s.auditEvents.action, 'award.app_unit_drawn')));
		expect(auditRow).toMatchObject({
			actorId: tenant.operatorId,
			targetType: 'prize',
			targetId: ids.moto,
			metadata: { round: 1, sequence: 1, slot: 1, attempt: 1, candidateCount: 4, candidateSha256: motoTirada.candidateSha256, entryNumber: record!.entryNumber }
		});
	});

	it('never draws the same unit twice: a repeated request is refused and changes nothing', async () => {
		const api = client(tenant);
		const before = await footprint(tenant);
		expectRefusal(await api.draw({ prizeId: ids.moto, slot: 1 }), 409, 'unit_has_winner', 'Esta unidad ya tiene ganador: no se vuelve a sortear');
		expect(await footprint(tenant)).toEqual(before);
	});

	it('draws the next unit among the coupons still without a prize, and lists every tirada of the round in order', async () => {
		const api = client(tenant);
		ctx.clock.now = new Date(ctx.clock.now.getTime() + 60_000);
		const response = await api.draw({ prizeId: ids.cash, slot: 2 });
		expect(response.statusCode, response.body).toBe(201);
		cashTirada = response.json();
		const left = ['0000', '0001', '0003', '0004'].filter((entryNumber) => entryNumber !== motoTirada.pick.entryNumber);
		expect(cashTirada).toMatchObject({ sequence: 2, attempt: 1, prizeTitle: '$100.000', slot: 2, candidateCount: 3, candidateSha256: sha256Hex(left.join('\n')) });
		expect(cashTirada.candidates.map((candidate) => candidate.entryNumber)).toEqual(left);
		const [event] = await ctx.db.withTenant(tenant.id, (tx) => tx.select({ title: s.drawEvents.title }).from(s.drawEvents).where(and(eq(s.drawEvents.kind, 'app_draw'), eq(s.drawEvents.occurredAt, ctx.clock.now))));
		expect(event).toEqual({ title: 'Sorteo en la app: $100.000, unidad 2' });

		const listed = await api.units();
		expect(listed.statusCode).toBe(200);
		const strip = ({ campaign: _campaign, candidates: _candidates, ...tirada }: TiradaResult) => tirada;
		expect(listed.json()).toMatchObject({ tiradas: [strip(motoTirada), strip(cashTirada)], units: [], candidateCount: null, reason: 'No hay premios vacantes para sortear en la aplicación' });
		expectNoPersonalData(listed.body);
		// A replay gives the stored tirada with its candidates, for the reel.
		const replayed = await api.replay(1);
		expect(replayed.statusCode).toBe(200);
		expect(replayed.json()).toEqual(motoTirada);
		expectRefusal(await api.replay(3), 404, 'not_found');
	});

	it('leaves both units on the board from the in-app draw, with no alternates, through the usual decision and delivery', async () => {
		const api = client(tenant);
		const board = await api.board();
		const moto = board.prizes.find((prize: { kind: string }) => prize.kind === 'vehicle');
		expect(moto.alternatesCount).toBe(0);
		expect(moto.slots[0].state).toBe('verifying');
		expect(moto.slots[0].awards.map((award: { role: string; source: string; entryNumber: number }) => [award.role, award.source, award.entryNumber])).toEqual([['winner', 'app_draw', Number(motoTirada.pick.entryNumber)]]);
		expect(board.appDraw).toEqual({ state: 'drawn', round: 1, drawnAt: cashTirada.drawnAt, reason: null, candidateCount: 3 });

		const accepted = await api.request('POST', `/admin/awards/${moto.slots[0].awards[0].id}/decision`, { decision: 'accepted' });
		expect(accepted.statusCode, accepted.body).toBe(200);
		const delivered = await api.request('PUT', `/admin/awards/${moto.slots[0].awards[0].id}/fulfillment`, { status: 'delivered' });
		expect(delivered.statusCode, delivered.body).toBe(200);
		expect(delivered.json().prizes.find((prize: { kind: string }) => prize.kind === 'vehicle').slots[0].state).toBe('delivered');
	});

	it('makes a unit drawable again once its winner declines: not voidable, not finished, then drawn with a new attempt', async () => {
		const api = client(tenant);
		const cash = (await api.board()).prizes.find((prize: { kind: string }) => prize.kind === 'cash');
		const declined = await api.request('POST', `/admin/awards/${cash.slots[1].awards[0].id}/decision`, { decision: 'declined', notes: 'No respondió en el plazo' });
		expect(declined.statusCode, declined.body).toBe(200);
		const board = declined.json();
		const unit = board.prizes.find((prize: { kind: string }) => prize.kind === 'cash').slots[1];
		expect(unit).toMatchObject({ state: 'exhausted', canDeclareVoid: false });
		expect(board.appDraw).toMatchObject({ state: 'ready', candidateCount: 2 });
		expect((await api.units()).json()).toMatchObject({ units: [{ prizeId: ids.cash, prizeTitle: '$100.000', slot: 2, state: 'exhausted' }], candidateCount: 2, reason: null });

		const before = await footprint(tenant);
		expectRefusal(
			await api.request('POST', `/admin/campaigns/${tenant.campaignId}/awards/${ids.cash}/slots/2/void`, { reason: 'Nadie respondió' }),
			409,
			'app_draw_possible',
			'Todavía hay cupones sin premio: sorteá la unidad en la aplicación antes de declararla desierta'
		);
		expectRefusal(await api.request('POST', `/admin/campaigns/${tenant.campaignId}/transition`, { to: 'fulfilled' }, tenant.ownerId), 409, 'prizes_vacant', 'Hay premios vacantes: sortealos en la aplicación');
		expect(await footprint(tenant)).toEqual(before);

		ctx.clock.now = new Date(ctx.clock.now.getTime() + 60_000);
		const again = await api.draw({ prizeId: ids.cash, slot: 2 });
		expect(again.statusCode, again.body).toBe(201);
		// The declined coupon keeps its award, so it is not a candidate again.
		const left = ['0000', '0001', '0003', '0004'].filter((entryNumber) => entryNumber !== motoTirada.pick.entryNumber && entryNumber !== cashTirada.pick.entryNumber);
		expect(again.json()).toMatchObject({ sequence: 3, attempt: 2, slot: 2, candidateCount: 2, candidateSha256: sha256Hex(left.join('\n')) });
		const slot = (await api.board()).prizes.find((prize: { kind: string }) => prize.kind === 'cash').slots[1];
		expect(slot.state).toBe('verifying');
		expect(slot.awards.map((award: { role: string; rank: number; status: string; active: boolean; source: string }) => [award.role, award.rank, award.status, award.active, award.source])).toEqual([
			['winner', 1, 'declined', false, 'app_draw'],
			['winner', 2, 'pending_verification', true, 'app_draw']
		]);
	});

	// Each tirada's list is the previous one minus its pick, so a list or its hash would reveal the
	// earlier picks: both wait for the round's results, like the picks (review R1-tirada-pick-leak).
	it('publishes each tirada with its count at once, its hash, pick and candidate file with the results', async () => {
		const api = client(tenant);
		const early = await api.transparency();
		expect(early.appDraws).toEqual([]);
		expect(early.appUnitDraws.map((tirada: Record<string, unknown>) => [tirada.sequence, tirada.prize, tirada.slot, tirada.attempt, tirada.entryNumber])).toEqual([
			[1, 'Moto', 1, 1, null],
			[2, '$100.000', 2, 1, null],
			[3, '$100.000', 2, 2, null]
		]);
		expect(early.appUnitDraws[0]).toEqual({ round: 1, sequence: 1, prize: 'Moto', slot: 1, attempt: 1, drawnAt: motoTirada.drawnAt, candidateCount: 4, candidateSha256: null, entryNumber: null });
		expect(JSON.stringify(early)).not.toContain('***');
		for (const sequence of [1, 2, 3]) expect((await api.file(1, sequence)).statusCode).toBe(404);

		expect((await api.event('result_published', 'Resultados')).statusCode).toBe(200);
		const file = await api.file(1, 1);
		expect(file.statusCode).toBe(200);
		expect(file.headers['content-type']).toBe('text/plain; charset=utf-8');
		expect(file.headers['x-content-sha256']).toBe(motoTirada.candidateSha256);
		expect(file.headers['content-disposition']).toBe(`attachment; filename="${tenant.campaignSlug}-cupones-sorteo-app-ronda-1-tirada-1.txt"`);
		expect(file.body).toBe('0000\n0001\n0003\n0004');
		expect(sha256Hex(file.body)).toBe(motoTirada.candidateSha256);
		expect((await api.file(1, 4)).statusCode).toBe(404);
		expect((await api.file(2, 1)).statusCode).toBe(404);
		expect((await ctx.app.inject({ method: 'GET', url: `/public/campaigns/${tenant.campaignSlug}/app-draws/1/units/1/candidates.txt`, headers: headers(other) })).statusCode).toBe(404);

		const published = await api.transparency();
		expect(published.appUnitDraws[0].candidateSha256).toBe(motoTirada.candidateSha256);
		expect(published.appUnitDraws[0].entryNumber).toBe(motoTirada.pick.entryNumber);
		expect(published.appUnitDraws[1].entryNumber).toBe(cashTirada.pick.entryNumber);
		expectNoPersonalData(JSON.stringify(published.appUnitDraws));
		const moto = published.awards.find((award: { prize: string; role: string }) => award.prize === 'Moto' && award.role === 'winner');
		expect(moto).toMatchObject({ source: 'app_draw', entryNumber: Number(motoTirada.pick.entryNumber) });
	});
});

describe('simultaneous requests and running out', () => {
	it('gives a unit one winner when several requests arrive at once: one 201, the rest refused, one tirada', async () => {
		const target = await unitsTenant('units-race', 3);
		const api = client(target);
		const ids = await prizeIds(target);
		await api.toAwarding();
		await api.quiniela(twenty());
		const before = await footprint(target);
		const responses = await Promise.all(Array.from({ length: 5 }, () => api.draw({ prizeId: ids.moto, slot: 1 })));
		expect(responses.map((response) => response.statusCode).sort()).toEqual([201, 409, 409, 409, 409]);
		for (const response of responses.filter((candidate) => candidate.statusCode === 409)) expect(response.json().error.code).toBe('unit_has_winner');
		expect(await footprint(target)).toEqual({ ...before, awards: before.awards + 1, tiradas: 1, events: before.events + 1, audits: before.audits + 1 });
	});

	it('refuses once every coupon holds an award, then the unit can be declared void and is never drawn', async () => {
		// One buyer, coupons 0000-0001: the Quiniela gives 0000 the first cash unit, the app 0001 the second.
		const target = await unitsTenant('units-empty', 1);
		const api = client(target);
		const ids = await prizeIds(target);
		await api.toAwarding();
		await api.quiniela(twenty(0));
		expect((await api.draw({ prizeId: ids.cash, slot: 2 })).statusCode).toBe(201);
		const before = await footprint(target);
		expectRefusal(await api.draw({ prizeId: ids.moto, slot: 1 }), 409, 'no_candidates', 'No quedan cupones sin premio para sortear los premios vacantes');
		expect(await footprint(target)).toEqual(before);
		expect((await api.units()).json()).toMatchObject({ units: [{ prizeId: ids.moto, slot: 1, state: 'vacant' }], candidateCount: 0, reason: 'No quedan cupones sin premio para sortear los premios vacantes' });
		expect((await api.board()).appDraw).toMatchObject({ state: 'unavailable', candidateCount: 0, reason: 'No quedan cupones sin premio para sortear los premios vacantes' });

		const voided = await api.request('POST', `/admin/campaigns/${target.campaignId}/awards/${ids.moto}/slots/1/void`, { reason: 'No quedan cupones para sortear' });
		expect(voided.statusCode, voided.body).toBe(200);
		const afterVoid = await footprint(target);
		expectRefusal(await api.draw({ prizeId: ids.moto, slot: 1 }), 409, 'slot_void', 'Esta unidad fue declarada desierta: no se sortea');
		expect(await footprint(target)).toEqual(afterVoid);
	});
});

describe('the one-shot draw of ADR 0024', () => {
	it('is no longer drawn: the run is refused and writes nothing', async () => {
		const target = await unitsTenant('units-legacy-off', 2);
		const api = client(target);
		await api.toAwarding();
		await api.quiniela(twenty());
		const before = await footprint(target);
		expectRefusal(
			await api.request('POST', `/admin/campaigns/${target.campaignId}/app-draw`),
			409,
			'app_draw_per_unit',
			'El sorteo en la app ahora se hace premio por premio: elegí la unidad que vas a sortear'
		);
		expectRefusal(await api.request('GET', `/admin/campaigns/${target.campaignId}/app-draw`), 404, 'app_draw_missing');
		expect(await footprint(target)).toEqual(before);
	});

	it('stays readable once stored: replayed, listed in transparency and downloadable, next to the tiradas drawn after it', async () => {
		const target = await unitsTenant('units-legacy', 3);
		const api = client(target);
		const ids = await prizeIds(target);
		await api.toAwarding();
		await api.quiniela(twenty());
		// A one-shot draw stored before this change gave the moto to coupon 0003.
		const legacyHash = sha256Hex('0000\n0001\n0002\n0003\n0004\n0005');
		await ctx.db.withTenant(target.id, async (tx) => {
			const [record] = await tx
				.insert(s.appDraws)
				.values({
					organizationId: target.id,
					campaignId: target.campaignId,
					round: 1,
					candidateSha256: legacyHash,
					candidateCount: 6,
					candidates: [0, 1, 2, 3, 4, 5],
					picks: [{ prizeId: ids.moto, slot: 1, role: 'winner', rank: 1, entryNumber: 3 }],
					drawnAt: ctx.clock.now,
					recordedBy: target.operatorId
				})
				.returning();
			const [entry] = await tx.select({ id: s.participationEntries.id }).from(s.participationEntries).where(and(eq(s.participationEntries.campaignId, target.campaignId), eq(s.participationEntries.entryNumber, 3)));
			await tx.insert(s.prizeAwards).values({ organizationId: target.id, campaignId: target.campaignId, prizeId: ids.moto, slot: 1, role: 'winner', rank: 1, entryId: entry!.id, notes: 'Sorteo en la app', round: 1, appDrawId: record!.id });
		});
		const replay = await api.request('POST', `/admin/campaigns/${target.campaignId}/app-draw`);
		expect(replay.statusCode).toBe(200);
		expect(replay.json()).toMatchObject({ round: 1, candidateCount: 6, candidateSha256: legacyHash, picks: [{ prizeTitle: 'Moto', slot: 1, role: 'winner', rank: 1, entryNumber: '0003', maskedName: 'Ma*** G.' }] });
		expect((await api.request('GET', `/admin/campaigns/${target.campaignId}/app-draw`)).json()).toEqual(replay.json());

		// The cash units it did not cover are drawn per unit, among the coupons still without a prize.
		const tirada = await api.draw({ prizeId: ids.cash, slot: 1 });
		expect(tirada.statusCode, tirada.body).toBe(201);
		expect(tirada.json()).toMatchObject({ sequence: 1, candidateCount: 5, candidateSha256: sha256Hex('0000\n0001\n0002\n0004\n0005') });

		expect((await api.event('result_published', 'Resultados')).statusCode).toBe(200);
		const transparency = await api.transparency();
		expect(transparency.appDraws).toEqual([
			{ round: 1, drawnAt: ctx.clock.now.toISOString(), candidateCount: 6, candidateSha256: legacyHash, picks: [{ prize: 'Moto', slot: 1, role: 'winner', rank: 1, entryNumber: '0003' }] }
		]);
		expect(transparency.appUnitDraws.map((row: { prize: string; slot: number }) => [row.prize, row.slot])).toEqual([['$100.000', 1]]);
		const file = await ctx.app.inject({ method: 'GET', url: `/public/campaigns/${target.campaignSlug}/app-draws/1/candidates.txt`, headers: headers(target) });
		expect(file.statusCode).toBe(200);
		expect(sha256Hex(file.body)).toBe(legacyHash);
	});
});
