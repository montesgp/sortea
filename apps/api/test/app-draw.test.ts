import { randomUUID } from 'node:crypto';
import { and, count, eq, schema as s } from '@sortea/db';
import { sha256Hex } from '@sortea/domain/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminHeaders, createTenant, createTestContext, headers, openCampaign, placeOrder, webhookRequest, type TenantFixture, type TestContext } from './helpers';

/**
 * ADR 0024 (odd/tasks/owner-feedback-2026-11-11b.md, T9, S5, S10, L14; as
 * amended by odd/tasks/draw-room.md T3): the units a round's Quiniela draw left
 * vacant are drawn in the application among the eligible coupons that hold no
 * award, one unit per tirada and never an alternate. The server draws and
 * stores the tirada before any screen shows it; a repeated request draws nothing.
 */
let ctx: TestContext;
let tenant: TenantFixture;
let other: TenantFixture;
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
	candidates: Candidate[];
}

const twenty = (...head: number[]) => [...head, ...Array.from({ length: 20 - head.length }, (_, index) => 1_000 + index)];
const evidenceUrl = 'https://loteria.example/extracto.pdf';

/** Three buyers, two coupons each: Juana 0000-0001, Martín 0002-0003, Lucía 0004-0005 (who does not consent to be named). */
const buyers = [
	{ documentNumber: '30.111.222', firstName: 'Juana', lastName: 'Pérez', email: 'juana.perez@example.com', publicity: true },
	{ documentNumber: '30.333.444', firstName: 'martín', lastName: 'Gómez', email: 'martin.gomez@example.com', publicity: true },
	{ documentNumber: '30.555.666', firstName: 'Lucía', lastName: 'Ñáñez', email: 'lucia.nanez@example.com', publicity: false }
];
const masked: Record<string, string> = { '0000': 'Ju*** P.', '0001': 'Ju*** P.', '0002': 'Ma*** G.', '0003': 'Ma*** G.', '0004': 'Lu*** Ñ.', '0005': 'Lu*** Ñ.' };

function client(target: TenantFixture) {
	const request = async (method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: unknown, userId = target.operatorId) =>
		ctx.app.inject({ method, url, headers: await adminHeaders(ctx, target, userId), payload: payload as Record<string, unknown> | undefined });
	const campaign = `/admin/campaigns/${target.campaignId}`;
	return {
		request,
		preview: (userId?: string, campaignId = target.campaignId) => request('GET', `/admin/campaigns/${campaignId}/app-draw/preview`, undefined, userId),
		run: (userId?: string, campaignId = target.campaignId) => request('POST', `/admin/campaigns/${campaignId}/app-draw`, undefined, userId),
		/** One tirada for the unit of the prize of that kind. */
		async unit(kind: string, slot = 1, userId?: string, campaignId = target.campaignId) {
			const [prize] = await ctx.db.withTenant(target.id, (tx) => tx.select({ id: s.prizes.id }).from(s.prizes).where(and(eq(s.prizes.campaignId, target.campaignId), eq(s.prizes.kind, kind as 'cash'))));
			return request('POST', `/admin/campaigns/${campaignId}/app-draw/units`, { prizeId: prize!.id, slot }, userId);
		},
		replay: (sequence: number) => request('GET', `${campaign}/app-draw/units/${sequence}`),
		result: (userId?: string, campaignId = target.campaignId) => request('GET', `/admin/campaigns/${campaignId}/app-draw`, undefined, userId),
		board: async () => (await request('GET', `${campaign}/awards`)).json(),
		event: (kind: string, title: string) => request('POST', `${campaign}/draw-events`, { kind, title, occurredAt: ctx.clock.now.toISOString() }),
		async quiniela(extracts: number[]) {
			const body = { source: 'Quiniela de la Ciudad, Nocturna', drawnAt: '2026-11-30T00:00:00Z', extracts, evidenceUrl };
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
		publicCampaign: async () => (await ctx.app.inject({ method: 'GET', url: `/public/campaigns/${target.campaignSlug}`, headers: headers(target) })).json()
	};
}

async function setPrize(target: TenantFixture, kind: string, patch: Record<string, unknown>) {
	const auth = await adminHeaders(ctx, target);
	const { prizes } = (await ctx.app.inject({ method: 'GET', url: `/admin/campaigns/${target.campaignId}/prizes`, headers: auth })).json() as { prizes: { id: string; kind: string }[] };
	const response = await ctx.app.inject({ method: 'PATCH', url: `/admin/prizes/${prizes.find((prize) => prize.kind === kind)!.id}`, headers: auth, payload: patch });
	expect(response.statusCode, response.body).toBe(200);
}

/**
 * The cash prize first, then the moto (one alternate), both from the Quiniela;
 * the kit is recorded by hand. `vehicle: false` leaves the moto manual.
 */
async function drawTenant(label: string, orders: number, options: { vehicle?: boolean } = {}) {
	const target = await createTenant(ctx, label);
	ctx.clock.now = new Date('2026-10-25T15:00:00Z');
	await setPrize(target, 'cash', { quantity: 1, alternatesCount: 0, position: 1, mechanism: 'quiniela' });
	await setPrize(target, 'vehicle', { alternatesCount: 1, position: 2, ...(options.vehicle === false ? {} : { mechanism: 'quiniela' }) });
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

/** Everything a refused or repeated draw must leave alone. */
async function footprint(target: TenantFixture) {
	return ctx.db.withTenant(target.id, async (tx) => {
		const [[awards], [draws], [events], [audits]] = await Promise.all([
			tx.select({ value: count() }).from(s.prizeAwards),
			tx.select({ value: count() }).from(s.appUnitDraws),
			tx.select({ value: count() }).from(s.drawEvents),
			tx.select({ value: count() }).from(s.auditEvents)
		]);
		return { awards: awards!.value, draws: draws!.value, events: events!.value, audits: audits!.value };
	});
}

/** Nothing a buyer typed except the masked first two letters and initial. */
function expectNoPersonalData(body: string) {
	for (const buyer of buyers) {
		for (const value of [buyer.documentNumber, buyer.email, buyer.lastName, buyer.firstName, 'Cafayate', '5555-000']) expect(body, value).not.toContain(value);
	}
}

beforeAll(async () => {
	ctx = await createTestContext();
	other = await drawTenant('app-draw-other', 1);
	tenant = await drawTenant('app-draw', 3);
	await ctx.db.withPlatform((db) => db.insert(s.organizationMembers).values({ organizationId: tenant.id, userId: financeId, email: `finance@${tenant.host}`, role: 'finance_manager' }));
});
afterAll(() => ctx.close());

describe('before the Quiniela result', () => {
	it('refuses while the campaign is not awarding', async () => {
		const api = client(tenant);
		for (const response of [await api.preview(), await api.unit('vehicle')]) {
			expect(response.statusCode).toBe(409);
			expect(response.json().error.code).toBe('not_awarding');
		}
	});

	it('refuses until the round Quiniela result is recorded, writing nothing', async () => {
		const api = client(tenant);
		await api.toAwarding();
		const before = await footprint(tenant);
		for (const response of [await api.preview(), await api.unit('vehicle')]) {
			expect(response.statusCode).toBe(409);
			expect(response.json().error).toMatchObject({ code: 'quiniela_draw_required', message: 'Primero registrá el resultado de la Quiniela de esta ronda' });
		}
		const missing = await api.result();
		expect(missing.statusCode).toBe(404);
		expect(missing.json().error).toMatchObject({ code: 'app_draw_missing', message: 'Los premios vacantes de esta ronda todavía no se sortearon en la aplicación' });
		expect(await footprint(tenant)).toEqual(before);
	});
});

describe('the draw of the vacant moto', () => {
	let drawn: Tirada;

	it('previews the vacant units and every coupon with no award, masked, writing nothing', async () => {
		const api = client(tenant);
		// Coupon 0002 wins the cash prize; the moto stays vacant.
		await api.quiniela(twenty(2));
		const before = await footprint(tenant);
		const response = await api.preview();
		expect(response.statusCode, response.body).toBe(200);
		const preview = response.json();
		const prizeId = (await api.board()).prizes.find((prize: { kind: string }) => prize.kind === 'vehicle').id;
		expect(preview).toEqual({
			campaign: { id: tenant.campaignId, title: 'Moto 0 km', round: 1, entryDigits: 4, timezone: 'America/Argentina/Buenos_Aires' },
			vacant: [{ prizeId, prizeTitle: 'Moto', slot: 1, alternatesCount: 1 }],
			candidates: ['0000', '0001', '0003', '0004', '0005'].map((entryNumber) => ({ entryNumber, maskedName: masked[entryNumber] })),
			candidateCount: 5,
			candidateSha256: sha256Hex('0000\n0001\n0003\n0004\n0005')
		});
		expectNoPersonalData(response.body);
		expect(await footprint(tenant)).toEqual(before);
	});

	it('needs the permission that records results, and stays inside the organization', async () => {
		const api = client(tenant);
		const before = await footprint(tenant);
		for (const response of [await api.preview(financeId), await api.unit('vehicle', 1, financeId), await api.run(financeId), await api.result(financeId)]) expect(response.statusCode).toBe(403);

		const outsider = client(other);
		for (const response of [await outsider.preview(other.ownerId, tenant.campaignId), await outsider.unit('vehicle', 1, other.ownerId, tenant.campaignId), await outsider.result(other.ownerId, tenant.campaignId)]) {
			expect(response.statusCode).toBe(404);
		}
		expect(await footprint(tenant)).toEqual(before);
	});

	it('draws one winner among the candidates and no alternate, although the moto allows one, storing award, tirada, log and audit together', async () => {
		const api = client(tenant);
		const before = await footprint(tenant);
		const response = await api.unit('vehicle');
		expect(response.statusCode, response.body).toBe(201);
		drawn = response.json();
		expectNoPersonalData(response.body);

		expect(drawn).toMatchObject({ round: 1, sequence: 1, attempt: 1, prizeTitle: 'Moto', slot: 1, drawnAt: ctx.clock.now.toISOString(), candidateCount: 5, candidateSha256: sha256Hex('0000\n0001\n0003\n0004\n0005') });
		expect(drawn.candidates.map((candidate) => candidate.entryNumber)).toEqual(['0000', '0001', '0003', '0004', '0005']);
		expect(['0000', '0001', '0003', '0004', '0005']).toContain(drawn.pick.entryNumber);
		expect(drawn.pick.maskedName).toBe(masked[drawn.pick.entryNumber]);

		expect(await footprint(tenant)).toEqual({ awards: before.awards + 1, draws: 1, events: before.events + 1, audits: before.audits + 1 });
		const [record] = await ctx.db.withTenant(tenant.id, (tx) => tx.select().from(s.appUnitDraws));
		expect(record).toMatchObject({ round: 1, candidateCount: 5, candidates: [0, 1, 3, 4, 5], candidateSha256: drawn.candidateSha256, recordedBy: tenant.operatorId });
		const awards = await ctx.db.withTenant(tenant.id, (tx) =>
			tx
				.select({ role: s.prizeAwards.role, rank: s.prizeAwards.rank, entryNumber: s.participationEntries.entryNumber, notes: s.prizeAwards.notes, status: s.prizeAwards.status })
				.from(s.prizeAwards)
				.innerJoin(s.participationEntries, eq(s.participationEntries.id, s.prizeAwards.entryId))
				.where(eq(s.prizeAwards.appUnitDrawId, record!.id))
		);
		expect(awards).toEqual([{ role: 'winner', rank: 1, entryNumber: Number(drawn.pick.entryNumber), notes: 'Sorteo en la app', status: 'pending_verification' }]);
		expect(await ctx.db.withTenant(tenant.id, (tx) => tx.select({ id: s.prizeAwards.id }).from(s.prizeAwards).where(eq(s.prizeAwards.role, 'alternate')))).toEqual([]);

		const [event] = await ctx.db.withTenant(tenant.id, (tx) => tx.select().from(s.drawEvents).where(eq(s.drawEvents.kind, 'app_draw')));
		expect(event).toMatchObject({ round: 1, title: 'Sorteo en la app: Moto', detail: 'Entre 5 cupones sin premio.', recordedBy: tenant.operatorId });
		const [auditRow] = await ctx.db.withTenant(tenant.id, (tx) => tx.select().from(s.auditEvents).where(eq(s.auditEvents.action, 'award.app_unit_drawn')));
		expect(auditRow).toMatchObject({ actorId: tenant.operatorId, metadata: { round: 1, sequence: 1, slot: 1, attempt: 1, candidateCount: 5, candidateSha256: drawn.candidateSha256, entryNumber: Number(drawn.pick.entryNumber) } });
	});

	it('draws nothing again: a repeated request is refused, a reload replays the tirada, and nothing is left to preview', async () => {
		const api = client(tenant);
		const before = await footprint(tenant);
		const again = await api.unit('vehicle');
		expect(again.statusCode).toBe(409);
		expect(again.json().error).toMatchObject({ code: 'unit_has_winner', message: 'Esta unidad ya tiene ganador: no se vuelve a sortear' });
		const reloaded = await api.replay(1);
		expect(reloaded.statusCode).toBe(200);
		expect(reloaded.json()).toMatchObject(drawn);
		expectNoPersonalData(reloaded.body);
		expect(await footprint(tenant)).toEqual(before);

		const preview = await api.preview();
		expect(preview.statusCode).toBe(409);
		expect(preview.json().error).toMatchObject({ code: 'no_vacant_prizes', message: 'No hay premios vacantes para sortear en la aplicación' });
	});

	it('leaves the moto awarded on the board, from the in-app draw, through the usual decisions', async () => {
		const api = client(tenant);
		const board = await api.board();
		const moto = board.prizes.find((prize: { kind: string }) => prize.kind === 'vehicle');
		expect(moto.slots[0].state).toBe('verifying');
		expect(moto.slots[0].awards.map((award: { role: string; source: string }) => [award.role, award.source])).toEqual([['winner', 'app_draw']]);
		const cash = board.prizes.find((prize: { kind: string }) => prize.kind === 'cash');
		expect(cash.slots[0].awards.map((award: { source: string }) => award.source)).toEqual(['quiniela']);
		expect(board.appDraw).toEqual({ state: 'drawn', round: 1, drawnAt: drawn.drawnAt, reason: null, candidateCount: 5 });

		const decided = await api.request('POST', `/admin/awards/${moto.slots[0].awards[0].id}/decision`, { decision: 'accepted' });
		expect(decided.statusCode, decided.body).toBe(200);
		const detail = (await api.request('GET', `/admin/campaigns/${tenant.campaignId}`, undefined, tenant.ownerId)).json();
		expect(detail).toMatchObject({ vacantSlots: [], canReopen: false, appDraw: { state: 'drawn', round: 1 } });
	});

	it('publishes the tirada next to the Quiniela one, and its pick and winners once the results are out', async () => {
		const api = client(tenant);
		const early = await api.transparency();
		expect(early.appDraws).toEqual([]);
		expect(early.appUnitDraws).toEqual([
			{ round: 1, sequence: 1, prize: 'Moto', slot: 1, attempt: 1, drawnAt: drawn.drawnAt, candidateCount: 5, candidateSha256: null, entryNumber: null }
		]);
		expect(early.awards).toEqual([]);
		expect((await api.publicCampaign()).winners).toBeNull();

		expect((await api.event('result_published', 'Resultados')).statusCode).toBe(200);
		const published = await api.transparency();
		expectNoPersonalData(JSON.stringify(published));
		expect(published.appUnitDraws[0].entryNumber).toBe(drawn.pick.entryNumber);
		expect(published.appUnitDraws[0].candidateSha256).toBe(drawn.candidateSha256);
		expect(JSON.stringify(early)).not.toContain(drawn.candidateSha256);
		const moto = published.awards.find((award: { prize: string; role: string }) => award.prize === 'Moto' && award.role === 'winner');
		expect(moto).toMatchObject({ round: 1, slot: 1, source: 'app_draw', extractPosition: null, entryNumber: Number(drawn.pick.entryNumber) });
		expect(published.awards.find((award: { prize: string }) => award.prize === '$100.000')).toMatchObject({ source: 'quiniela', extractPosition: 1, entryNumber: 2 });

		// The winners table labels the source and names the holder only with the purchase's consent.
		const winners = (await api.publicCampaign()).winners as { title: string; units: { source: string; entryNumber: number; identity: { name: string } | null }[] }[];
		const unit = winners.find((prize) => prize.title === 'Moto')!.units[0]!;
		expect(unit.source).toBe('app_draw');
		expect(unit.entryNumber).toBe(Number(drawn.pick.entryNumber));
		const holder = buyers[Math.floor(unit.entryNumber / 2)]!;
		expect(unit.identity).toEqual(holder.publicity ? { name: `${holder.firstName} ${holder.lastName}`, city: 'Cafayate', chances: 2 } : null);
		expect(winners.find((prize) => prize.title === '$100.000')!.units[0]!.source).toBe('quiniela');
	});
});

describe('refusals', () => {
	it('refuses when the Quiniela left nothing vacant', async () => {
		// Only the cash prize comes from the Quiniela, and coupon 0001 matches it.
		const target = await drawTenant('app-draw-full', 1, { vehicle: false });
		const api = client(target);
		await api.toAwarding();
		await api.quiniela(twenty(1));
		const before = await footprint(target);
		const preview = await api.preview();
		expect(preview.statusCode).toBe(409);
		expect(preview.json().error).toMatchObject({ code: 'no_vacant_prizes', message: 'No hay premios vacantes para sortear en la aplicación' });
		const held = await api.unit('cash');
		expect(held.statusCode).toBe(409);
		expect(held.json().error.code).toBe('unit_has_winner');
		expect(await footprint(target)).toEqual(before);
	});

	it('refuses when every coupon already holds an award', async () => {
		// Coupon 0000 wins the cash prize, 0001 the kit by hand; the moto stays vacant with nobody left.
		const target = await drawTenant('app-draw-empty', 1);
		const api = client(target);
		await api.toAwarding();
		await api.quiniela(twenty(0));
		expect((await api.event('mechanism_recorded', 'Kit: acta notarial')).statusCode).toBe(200);
		const kit = (await api.board()).prizes.find((prize: { kind: string }) => prize.kind === 'product');
		expect((await api.request('PUT', `/admin/campaigns/${target.campaignId}/awards/${kit.id}/slots/1`, { winner: 1, alternates: [] })).statusCode).toBe(200);
		const before = await footprint(target);
		for (const response of [await api.preview(), await api.unit('vehicle')]) {
			expect(response.statusCode).toBe(409);
			expect(response.json().error).toMatchObject({ code: 'no_candidates', message: 'No quedan cupones sin premio para sortear los premios vacantes' });
		}
		expect(await footprint(target)).toEqual(before);
		expect((await api.board()).appDraw).toEqual({ state: 'unavailable', round: 1, drawnAt: null, reason: 'No quedan cupones sin premio para sortear los premios vacantes', candidateCount: 0 });
	});
});
