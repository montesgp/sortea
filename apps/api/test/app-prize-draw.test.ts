import { randomUUID } from 'node:crypto';
import { and, asc, count, eq, schema as s } from '@sortea/db';
import { appDrawCandidateText, commitDrandRound, drandRoundTime } from '@sortea/domain';
import { drawFromBeacon, sha256Hex } from '@sortea/domain/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminHeaders, createTenant, createTestContext, fakeBeacon, headers, openCampaign, placeOrder, webhookRequest, type TenantFixture, type TestContext } from './helpers';

/**
 * odd/tasks/draw-room.md T8 (S6-S8, L7), ADR 0026: an `app` prize is drawn
 * whole, with ONE tirada that gives a winner to every pending unit. Clicking
 * "Sortear" commits the next drand round, the units and the candidate list
 * before that round exists; the API then reads the round (a fake beacon here,
 * test/drand.test.ts covers the real client) and derives the picks with
 * `drawFromBeacon`. On failure the tirada stays pending and resumes with the
 * same round. No Quiniela is needed.
 */
let ctx: TestContext;

interface Coupon {
	entryNumber: string;
	maskedName: string;
}
interface PrizeTirada {
	prizeId: string;
	prizeTitle: string;
	round: number;
	sequence: number;
	attempt: number;
	state: 'committed' | 'drawn';
	units: number[];
	drandRound: number;
	drandRoundAt: string;
	committedAt: string;
	candidateCount: number;
	candidateSha256: string;
	beacon: { signature: string; randomness: string; url: string } | null;
	picks: { slot: number; entryNumber: string; maskedName: string }[] | null;
	revealedAt: string | null;
	candidates: Coupon[];
}

/** Five buyers, two coupons each: 0000-0009. */
const buyers = [
	{ documentNumber: '30.111.222', firstName: 'Juana', lastName: 'Pérez', email: 'juana.perez@example.com' },
	{ documentNumber: '30.333.444', firstName: 'Martín', lastName: 'Gómez', email: 'martin.gomez@example.com' },
	{ documentNumber: '30.555.666', firstName: 'Lucía', lastName: 'Ñáñez', email: 'lucia.nanez@example.com' },
	{ documentNumber: '30.777.888', firstName: 'Pedro', lastName: 'Ríos', email: 'pedro.rios@example.com' },
	{ documentNumber: '30.999.000', firstName: 'Sofía', lastName: 'Luna', email: 'sofia.luna@example.com' }
];
const maskedOf = (entryNumber: number) => ['Ju*** P.', 'Ma*** G.', 'Lu*** Ñ.', 'Pe*** R.', 'So*** L.'][Math.floor(entryNumber / 2)]!;
const pad = (entryNumber: number) => String(entryNumber).padStart(4, '0');

function expectNoPersonalData(body: string) {
	for (const buyer of buyers) {
		for (const value of [buyer.documentNumber, buyer.email, buyer.lastName, buyer.firstName, 'Cafayate', '5555-000']) expect(body, value).not.toContain(value);
	}
}

function expectRefusal(response: { statusCode: number; json: () => { error: { code: string; message: string } } }, status: number, code: string, message?: string) {
	expect(response.statusCode).toBe(status);
	expect(response.json().error).toMatchObject(message ? { code, message } : { code });
}

function client(target: TenantFixture) {
	const request = async (method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: unknown, userId = target.operatorId) =>
		ctx.app.inject({ method, url, headers: await adminHeaders(ctx, target, userId), payload: payload as Record<string, unknown> | undefined });
	const campaign = `/admin/campaigns/${target.campaignId}`;
	return {
		request,
		draw: (prizeId: string, userId?: string, campaignId = target.campaignId) => request('POST', `/admin/campaigns/${campaignId}/app-draw/prizes/${prizeId}`, undefined, userId),
		prizes: (userId?: string) => request('GET', `${campaign}/app-draw/prizes`, undefined, userId),
		board: async () => (await request('GET', `${campaign}/awards`)).json(),
		event: (kind: string, title: string) => request('POST', `${campaign}/draw-events`, { kind, title, occurredAt: ctx.clock.now.toISOString() }),
		async toAwarding() {
			ctx.clock.now = new Date('2026-11-29T01:00:00Z');
			expect((await request('POST', `${campaign}/close`, undefined, target.ownerId)).statusCode).toBe(200);
			expect((await request('POST', `${campaign}/transition`, { to: 'awarding' }, target.ownerId)).statusCode).toBe(200);
			ctx.clock.now = new Date('2026-11-30T12:00:00.500Z');
		},
		transparency: async () => (await ctx.app.inject({ method: 'GET', url: `/public/campaigns/${target.campaignSlug}/transparency`, headers: headers(target) })).json(),
		file: (round: number, sequence: number) => ctx.app.inject({ method: 'GET', url: `/public/campaigns/${target.campaignSlug}/app-draws/${round}/prizes/${sequence}/candidates.txt`, headers: headers(target) })
	};
}

async function setPrize(target: TenantFixture, kind: string, patch: Record<string, unknown>) {
	const auth = await adminHeaders(ctx, target);
	const { prizes } = (await ctx.app.inject({ method: 'GET', url: `/admin/campaigns/${target.campaignId}/prizes`, headers: auth })).json() as { prizes: { id: string; kind: string }[] };
	const response = await ctx.app.inject({ method: 'PATCH', url: `/admin/prizes/${prizes.find((prize) => prize.kind === kind)!.id}`, headers: auth, payload: patch });
	expect(response.statusCode, response.body).toBe(200);
}

/** The moto (1 unit) and five cash units drawn in the app, with no alternates; the kit recorded by hand. */
async function appTenant(label: string, orders: number) {
	const target = await createTenant(ctx, label);
	ctx.clock.now = new Date('2026-10-25T15:00:00Z');
	await setPrize(target, 'vehicle', { alternatesCount: 0, position: 1, mechanism: 'app' });
	await setPrize(target, 'cash', { quantity: 5, alternatesCount: 0, position: 2, mechanism: 'app' });
	await setPrize(target, 'product', { quantity: 1, alternatesCount: 0, position: 3 });
	await openCampaign(ctx, target);
	for (const [index, buyer] of buyers.slice(0, orders).entries()) {
		ctx.clock.now = new Date(ctx.clock.now.getTime() + 60_000);
		const order = await placeOrder(ctx, target, {
			buyer: { documentType: 'DNI', documentNumber: buyer.documentNumber, firstName: buyer.firstName, lastName: buyer.lastName, email: buyer.email, phone: `+54 9 11 5555-000${index}`, province: 'Salta', city: 'Cafayate' },
			consents: { terms: true, privacy: true, marketingEmail: false, winnerPublicity: true, adultDeclaration: true }
		});
		const payment = ctx.simulator.pay(order.checkoutId, 'approved');
		expect((await ctx.app.inject(webhookRequest(target, payment.id))).statusCode).toBe(200);
	}
	return target;
}

async function prizeIds(target: TenantFixture) {
	const rows = await ctx.db.withTenant(target.id, (tx) => tx.select({ id: s.prizes.id, kind: s.prizes.kind }).from(s.prizes).where(eq(s.prizes.campaignId, target.campaignId)));
	const of = (kind: string) => rows.find((row) => row.kind === kind)!.id;
	return { moto: of('vehicle'), cash: of('cash'), kit: of('product') };
}

/** Everything a refused or repeated request must leave alone. */
async function footprint(target: TenantFixture) {
	return ctx.db.withTenant(target.id, async (tx) => {
		const [[awards], [commits], [reveals], [events], [audits], [voids]] = await Promise.all([
			tx.select({ value: count() }).from(s.prizeAwards),
			tx.select({ value: count() }).from(s.appPrizeDraws),
			tx.select({ value: count() }).from(s.appPrizeDrawReveals),
			tx.select({ value: count() }).from(s.drawEvents),
			tx.select({ value: count() }).from(s.auditEvents),
			tx.select({ value: count() }).from(s.prizeSlotVoids)
		]);
		return { awards: awards!.value, commits: commits!.value, reveals: reveals!.value, events: events!.value, audits: audits!.value, voids: voids!.value };
	});
}

/** What the published algorithm gives for a fake round over these candidates. */
function expectedPicks(drandRound: number, candidates: number[], units: number[]) {
	const randomness = fakeBeacon(drandRound).randomness;
	const candidateSha256 = sha256Hex(appDrawCandidateText(candidates, 4));
	return drawFromBeacon({ randomness, candidateSha256, candidates, count: units.length }).map((entryNumber, index) => ({ slot: units[index]!, entryNumber: pad(entryNumber), maskedName: maskedOf(entryNumber) }));
}

beforeAll(async () => {
	ctx = await createTestContext();
});
afterAll(() => ctx.close());

describe('one tirada per app prize', () => {
	let tenant: TenantFixture;
	let other: TenantFixture;
	let ids: Awaited<ReturnType<typeof prizeIds>>;
	let otherIds: Awaited<ReturnType<typeof prizeIds>>;
	const otherHostId = randomUUID();
	const hostId = randomUUID();
	let cashTirada: PrizeTirada;

	beforeAll(async () => {
		// Another organization with coupons of its own and a draw host of its own.
		other = await appTenant('prize-other', 5);
		otherIds = await prizeIds(other);
		await ctx.db.withPlatform((db) => db.insert(s.organizationMembers).values({ organizationId: other.id, userId: otherHostId, email: `host@${other.host}`, role: 'draw_host' }));
		tenant = await appTenant('prize', 5);
		ids = await prizeIds(tenant);
		await ctx.db.withPlatform((db) => db.insert(s.organizationMembers).values({ organizationId: tenant.id, userId: hostId, email: `host@${tenant.host}`, role: 'draw_host' }));
		// Another campaign of the same organization holds coupon 0050.
		await ctx.db.withTenant(tenant.id, async (tx) => {
			const [campaign] = await tx.select().from(s.campaigns).where(eq(s.campaigns.id, tenant.campaignId));
			const otherId = randomUUID();
			await tx.insert(s.campaigns).values({ ...campaign!, id: otherId, slug: `other-${otherId.slice(0, 8)}` });
			const [entry] = await tx.select().from(s.participationEntries).where(eq(s.participationEntries.campaignId, tenant.campaignId)).limit(1);
			await tx.insert(s.participationEntries).values({ ...entry!, id: randomUUID(), campaignId: otherId, entryNumber: 50, status: 'eligible' });
		});
	});

	it('refuses before the campaign is awarding, writing nothing', async () => {
		const api = client(tenant);
		const before = await footprint(tenant);
		expectRefusal(await api.draw(ids.cash), 409, 'not_awarding', 'Las adjudicaciones se registran con la campaña en adjudicación, después de publicar el manifiesto');
		const listed = await api.prizes();
		expect(listed.statusCode, listed.body).toBe(200);
		expect(listed.json()).toMatchObject({ candidateCount: null, reason: 'Las adjudicaciones se registran con la campaña en adjudicación, después de publicar el manifiesto' });
		expect(await footprint(tenant)).toEqual(before);
	});

	it('lists the app prizes in award order with their units, needing no Quiniela', async () => {
		const api = client(tenant);
		await api.toAwarding();
		// A refund after the close voids coupon 0009 (as payments/confirm.ts voidEntries does).
		await ctx.db.withTenant(tenant.id, (tx) =>
			tx.update(s.participationEntries).set({ status: 'void' }).where(and(eq(s.participationEntries.campaignId, tenant.campaignId), eq(s.participationEntries.entryNumber, 9)))
		);
		const response = await api.prizes();
		expect(response.statusCode, response.body).toBe(200);
		expect(response.json()).toEqual({
			campaign: { id: tenant.campaignId, title: 'Moto 0 km', round: 1, entryDigits: 4, timezone: 'America/Argentina/Buenos_Aires', awardOrder: 'first_to_last' },
			prizes: [
				{ prizeId: ids.moto, prizeTitle: 'Moto', position: 1, quantity: 1, state: 'pending', units: [{ slot: 1, state: 'pending' }], pendingUnits: [1], tiradas: [], reason: null },
				{
					prizeId: ids.cash,
					prizeTitle: '$100.000',
					position: 2,
					quantity: 5,
					state: 'pending',
					units: [1, 2, 3, 4, 5].map((slot) => ({ slot, state: 'pending' })),
					pendingUnits: [1, 2, 3, 4, 5],
					tiradas: [],
					reason: null
				}
			],
			candidateCount: 9,
			reason: null
		});
	});

	it('refuses prizes that are not drawn whole in the app, and other organizations, changing nothing', async () => {
		const api = client(tenant);
		const before = await footprint(tenant);
		expectRefusal(await api.draw(ids.kit), 409, 'not_app_prize', 'Este premio no se sortea en la aplicación: se carga a mano o sale de la Quiniela');
		expectRefusal(await api.draw(otherIds.cash), 404, 'not_found', 'Premio no encontrado');
		expectRefusal(await api.draw(randomUUID()), 404, 'not_found');
		// The per-unit tirada of Quiniela prizes never draws an app prize.
		expectRefusal(await api.request('POST', `/admin/campaigns/${tenant.campaignId}/app-draw/units`, { prizeId: ids.cash, slot: 1 }), 409, 'unit_not_drawable', 'Este premio se sortea entero en la aplicación, con una sola tirada: usá «Sortear» en el premio');
		// A draw host of another organization reaches only its own: this campaign is not found there.
		const foreign = await ctx.app.inject({
			method: 'POST',
			url: `/admin/campaigns/${tenant.campaignId}/app-draw/prizes/${ids.cash}`,
			headers: headers(other, { authorization: `Bearer ${await ctx.signAdmin(otherHostId, `host-${otherHostId.slice(0, 4)}@test`)}` })
		});
		expectRefusal(foreign, 404, 'not_found');
		// An auditor has neither permission.
		const auditorId = randomUUID();
		await ctx.db.withPlatform((db) => db.insert(s.organizationMembers).values({ organizationId: tenant.id, userId: auditorId, email: `auditor@${tenant.host}`, role: 'auditor' }));
		expect((await api.draw(ids.cash, auditorId)).statusCode).toBe(403);
		expect((await api.prizes(auditorId)).statusCode).toBe(403);
		expect(await footprint(tenant)).toEqual(before);
		expect(ctx.beacon.asked).toEqual([]);
	});

	it('draws five distinct winners for the five cash units in unit order, from the committed round', async () => {
		const api = client(tenant);
		const before = await footprint(tenant);
		const committedAt = ctx.clock.now;
		const drandRound = commitDrandRound(committedAt);
		const response = await api.draw(ids.cash);
		expect(response.statusCode, response.body).toBe(201);
		expectNoPersonalData(response.body);
		cashTirada = response.json();
		// 0000-0008: not the voided 0009, not another campaign's 0050, not another organization's.
		const candidates = [0, 1, 2, 3, 4, 5, 6, 7, 8];
		const candidateSha256 = sha256Hex(appDrawCandidateText(candidates, 4));
		const picks = expectedPicks(drandRound, candidates, [1, 2, 3, 4, 5]);
		expect(cashTirada).toEqual({
			campaign: { id: tenant.campaignId, title: 'Moto 0 km', round: 1, entryDigits: 4, timezone: 'America/Argentina/Buenos_Aires', awardOrder: 'first_to_last' },
			prizeId: ids.cash,
			prizeTitle: '$100.000',
			round: 1,
			sequence: 1,
			attempt: 1,
			state: 'drawn',
			units: [1, 2, 3, 4, 5],
			drandRound,
			drandRoundAt: drandRoundTime(drandRound).toISOString(),
			committedAt: committedAt.toISOString(),
			candidateCount: 9,
			candidateSha256,
			beacon: {
				signature: fakeBeacon(drandRound).signature,
				randomness: fakeBeacon(drandRound).randomness,
				url: `https://api.drand.sh/52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971/public/${drandRound}`
			},
			picks,
			revealedAt: committedAt.toISOString(),
			candidates: candidates.map((entryNumber) => ({ entryNumber: pad(entryNumber), maskedName: maskedOf(entryNumber) }))
		});
		expect(new Set(picks.map((pick) => pick.entryNumber)).size).toBe(5);
		// The round was read once it existed: the API waited for its publication time.
		expect(ctx.beacon.asked).toEqual([drandRound]);
		expect(ctx.files.waits.at(-1)).toBe(drandRoundTime(drandRound).getTime() - committedAt.getTime() + 300);

		const after = await footprint(tenant);
		expect(after).toMatchObject({ awards: before.awards + 5, commits: 1, reveals: 1, events: before.events + 2, audits: before.audits + 2 });
		const [commit, reveal, awards, events, audits] = await ctx.db.withTenant(tenant.id, (tx) =>
			Promise.all([
				tx.select().from(s.appPrizeDraws),
				tx.select().from(s.appPrizeDrawReveals),
				tx
					.select({ slot: s.prizeAwards.slot, role: s.prizeAwards.role, rank: s.prizeAwards.rank, notes: s.prizeAwards.notes, drawId: s.prizeAwards.appPrizeDrawId, entryNumber: s.participationEntries.entryNumber })
					.from(s.prizeAwards)
					.innerJoin(s.participationEntries, eq(s.participationEntries.id, s.prizeAwards.entryId))
					.where(eq(s.prizeAwards.prizeId, ids.cash))
					.orderBy(asc(s.prizeAwards.slot)),
				tx.select({ kind: s.drawEvents.kind, title: s.drawEvents.title, detail: s.drawEvents.detail }).from(s.drawEvents).where(eq(s.drawEvents.kind, 'app_draw')).orderBy(asc(s.drawEvents.createdAt)),
				tx.select({ action: s.auditEvents.action, metadata: s.auditEvents.metadata, targetId: s.auditEvents.targetId }).from(s.auditEvents).where(eq(s.auditEvents.targetId, ids.cash))
			])
		);
		expect(commit).toEqual([
			expect.objectContaining({ round: 1, sequence: 1, attempt: 1, prizeId: ids.cash, slots: [1, 2, 3, 4, 5], drandChain: '52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971', drandRound, candidates, candidateCount: 9, candidateSha256, committedBy: tenant.operatorId })
		]);
		expect(reveal).toEqual([expect.objectContaining({ drawId: commit[0]!.id, drandRound, signature: fakeBeacon(drandRound).signature, randomness: fakeBeacon(drandRound).randomness, picks: picks.map(({ slot, entryNumber }) => ({ slot, entryNumber: Number(entryNumber) })) })]);
		expect(awards).toEqual(picks.map((pick) => ({ slot: pick.slot, role: 'winner', rank: 1, notes: `Sorteo en la app (drand ${drandRound})`, drawId: commit[0]!.id, entryNumber: Number(pick.entryNumber) })));
		// The public log: the commitment with its round and count (no hash, no list), then the units filled (no coupons).
		expect(events).toEqual([
			{ kind: 'app_draw', title: 'Sorteo en la app comprometido: $100.000', detail: `Ronda ${drandRound} de drand, entre 9 cupones sin premio.` },
			{ kind: 'app_draw', title: 'Sorteo en la app: $100.000', detail: `Ronda ${drandRound} de drand: ganadores para las unidades 1, 2, 3, 4 y 5.` }
		]);
		expect(events.map((event) => event.detail).join(' ')).not.toContain(candidateSha256);
		expect(audits).toEqual([
			{ action: 'award.app_draw_committed', targetId: ids.cash, metadata: { round: 1, sequence: 1, attempt: 1, slots: [1, 2, 3, 4, 5], drandRound, candidateCount: 9, candidateSha256 } },
			{ action: 'award.app_draw_revealed', targetId: ids.cash, metadata: { round: 1, sequence: 1, attempt: 1, drandRound, randomness: fakeBeacon(drandRound).randomness, picks: picks.map(({ slot, entryNumber }) => ({ slot, entryNumber: Number(entryNumber) })) } }
		]);
		// Through the award model: the board shows them as in-app results.
		const board = await api.board();
		const cash = board.prizes.find((prize: { id: string }) => prize.id === ids.cash);
		expect(cash.slots.map((slot: { awards: { source: string; entryNumber: number }[] }) => [slot.awards[0]!.source, pad(slot.awards[0]!.entryNumber)])).toEqual(picks.map((pick) => ['app_draw', pick.entryNumber]));
	});

	it('refuses a prize with no pending units, changing nothing', async () => {
		const api = client(tenant);
		const before = await footprint(tenant);
		const asked = ctx.beacon.asked.length;
		expectRefusal(await api.draw(ids.cash), 409, 'no_pending_units', 'Todas las unidades de este premio ya tienen ganador: no hay nada para sortear');
		expect(await footprint(tenant)).toEqual(before);
		expect(ctx.beacon.asked).toHaveLength(asked);
	});

	it('with the beacon down, keeps the tirada pending (202), awards nothing, and resumes the SAME round', async () => {
		const api = client(tenant);
		const before = await footprint(tenant);
		ctx.beacon.available = false;
		ctx.clock.now = new Date('2026-11-30T12:05:00.000Z');
		const drandRound = commitDrandRound(ctx.clock.now);
		const asked = ctx.beacon.asked.length;
		const pending = await api.draw(ids.moto);
		expect(pending.statusCode, pending.body).toBe(202);
		expect(pending.json()).toMatchObject({ prizeId: ids.moto, state: 'committed', units: [1], drandRound, beacon: null, picks: null, revealedAt: null, candidateCount: 4, sequence: 2, attempt: 1 });
		// It kept asking for the committed round a bounded number of times.
		expect(ctx.beacon.asked.slice(asked)).toEqual([drandRound, drandRound, drandRound, drandRound]);
		expect(await footprint(tenant)).toMatchObject({ awards: before.awards, commits: 2, reveals: 1, events: before.events + 1 });
		const listed = (await api.prizes()).json();
		expect(listed.prizes[0]).toMatchObject({ prizeId: ids.moto, state: 'committed', pendingUnits: [1] });

		// While it waits, nothing else may take its candidates or close its unit.
		const kit = (await api.board()).prizes.find((prize: { id: string }) => prize.id === ids.kit);
		expect(kit).toBeTruthy();
		const message = 'Hay una tirada de «Moto» esperando su ronda de drand: terminala con «Sortear» antes de seguir';
		expectRefusal(await api.request('PUT', `/admin/campaigns/${tenant.campaignId}/awards/${ids.kit}/slots/1`, { winner: 0 }), 409, 'app_draw_pending', message);
		expectRefusal(await api.request('POST', `/admin/campaigns/${tenant.campaignId}/awards/${ids.moto}/slots/1/void`, { reason: 'Nadie lo puede ganar' }), 409, 'app_draw_pending', message);

		// Later, with another round ahead, a retry (by the draw host, draws.run) reads the committed one and reveals it.
		ctx.clock.now = new Date('2026-11-30T12:09:00.000Z');
		expect(commitDrandRound(ctx.clock.now)).not.toBe(drandRound);
		ctx.beacon.available = true;
		const resumed = await api.draw(ids.moto, hostId);
		expect(resumed.statusCode, resumed.body).toBe(201);
		expectNoPersonalData(resumed.body);
		const tirada: PrizeTirada = resumed.json();
		const candidates = (await ctx.db.withTenant(tenant.id, (tx) => tx.select().from(s.appPrizeDraws).where(eq(s.appPrizeDraws.prizeId, ids.moto))))[0]!.candidates;
		expect(candidates).toHaveLength(4);
		expect(tirada).toMatchObject({ state: 'drawn', drandRound, units: [1], picks: expectedPicks(drandRound, candidates, [1]) });
		expect(ctx.beacon.asked.at(-1)).toBe(drandRound);
		const after = await footprint(tenant);
		expect(after).toMatchObject({ awards: before.awards + 1, commits: 2, reveals: 2 });
		// Repeating it now finds nothing to draw.
		expectRefusal(await api.draw(ids.moto), 409, 'no_pending_units');
	});

	it('draws a unit again, alone, after its winner declined', async () => {
		const api = client(tenant);
		const board = await api.board();
		const cash = board.prizes.find((prize: { id: string }) => prize.id === ids.cash);
		const declined = cash.slots[2].awards[0];
		const decided = await api.request('POST', `/admin/awards/${declined.id}/decision`, { decision: 'declined', notes: 'No respondió en el plazo' });
		expect(decided.statusCode, decided.body).toBe(200);
		expect((await api.prizes()).json().prizes[1]).toMatchObject({ state: 'pending', pendingUnits: [3], units: expect.arrayContaining([{ slot: 3, state: 'exhausted' }]) });

		// Every coupon holding an award, the declined one included, stays out.
		const held = (
			await ctx.db.withTenant(tenant.id, (tx) =>
				tx.select({ entryNumber: s.participationEntries.entryNumber }).from(s.prizeAwards).innerJoin(s.participationEntries, eq(s.participationEntries.id, s.prizeAwards.entryId)).where(eq(s.prizeAwards.campaignId, tenant.campaignId))
			)
		).map((row) => row.entryNumber);
		const candidates = [0, 1, 2, 3, 4, 5, 6, 7, 8].filter((entryNumber) => !held.includes(entryNumber));
		expect(candidates).toHaveLength(3);
		const drandRound = commitDrandRound(ctx.clock.now);
		const response = await api.draw(ids.cash);
		expect(response.statusCode, response.body).toBe(201);
		const tirada: PrizeTirada = response.json();
		expect(tirada).toMatchObject({ attempt: 2, sequence: 3, units: [3], candidateCount: 3, picks: expectedPicks(drandRound, candidates, [3]) });
		const slot3 = await ctx.db.withTenant(tenant.id, (tx) =>
			tx.select({ rank: s.prizeAwards.rank, status: s.prizeAwards.status }).from(s.prizeAwards).where(and(eq(s.prizeAwards.prizeId, ids.cash), eq(s.prizeAwards.slot, 3))).orderBy(asc(s.prizeAwards.rank))
		);
		expect(slot3).toEqual([
			{ rank: 1, status: 'declined' },
			{ rank: 2, status: 'pending_verification' }
		]);
		const listed = (await api.prizes()).json();
		expect(listed.prizes[1]).toMatchObject({ state: 'drawn', pendingUnits: [] });
		expect(listed.prizes[1].tiradas.map((row: PrizeTirada) => [row.attempt, row.units])).toEqual([
			[1, [1, 2, 3, 4, 5]],
			[2, [3]]
		]);
		expect(listed.reason).toBe('No quedan premios para sortear en la aplicación');
	});

	it('shows the tirada in the draw room', async () => {
		const room = (await client(tenant).request('GET', `/admin/draw-room/campaigns/${tenant.campaignId}`)).json();
		expect(room.appPrizes.prizes.map((prize: { prizeId: string; state: string }) => [prize.prizeId, prize.state])).toEqual([
			[ids.moto, 'drawn'],
			[ids.cash, 'drawn']
		]);
		expect(room.appPrizes.prizes[1].tiradas[0]).not.toHaveProperty('candidates');
	});

	it('publishes count and round at once; hash, beacon, picks and the list only with the round results', async () => {
		const api = client(tenant);
		const early = await api.transparency();
		expect(early.appPrizeDraws).toHaveLength(3);
		expect(early.appPrizeDraws[0]).toEqual({
			round: 1,
			sequence: 1,
			prize: '$100.000',
			units: [1, 2, 3, 4, 5],
			attempt: 1,
			committedAt: cashTirada.committedAt,
			drandRound: cashTirada.drandRound,
			drandRoundAt: cashTirada.drandRoundAt,
			candidateCount: 9,
			candidateSha256: null,
			beacon: null,
			picks: null
		});
		expect(JSON.stringify(early)).not.toContain(cashTirada.candidateSha256);
		expect(JSON.stringify(early)).not.toContain(cashTirada.beacon!.randomness);
		expect((await api.file(1, 1)).statusCode).toBe(404);

		expect((await api.event('result_published', 'Resultados')).statusCode).toBe(200);
		const published = await api.transparency();
		expect(published.appPrizeDraws[0]).toEqual({
			round: 1,
			sequence: 1,
			prize: '$100.000',
			units: [1, 2, 3, 4, 5],
			attempt: 1,
			committedAt: cashTirada.committedAt,
			drandRound: cashTirada.drandRound,
			drandRoundAt: cashTirada.drandRoundAt,
			candidateCount: 9,
			candidateSha256: cashTirada.candidateSha256,
			beacon: cashTirada.beacon,
			picks: cashTirada.picks!.map(({ slot, entryNumber }) => ({ slot, entryNumber }))
		});
		expectNoPersonalData(JSON.stringify(published.appPrizeDraws));
		const file = await api.file(1, 1);
		expect(file.statusCode).toBe(200);
		expect(file.headers['content-type']).toBe('text/plain; charset=utf-8');
		expect(file.headers['content-disposition']).toBe('attachment; filename="moto-cupones-sorteo-app-ronda-1-premio-1.txt"');
		expect(file.headers['x-content-sha256']).toBe(cashTirada.candidateSha256);
		expect(file.headers['cache-control']).toBe('public, max-age=3600');
		expect(file.body).toBe('0000\n0001\n0002\n0003\n0004\n0005\n0006\n0007\n0008');
		expect(sha256Hex(file.body)).toBe(cashTirada.candidateSha256);
		expect((await api.file(1, 9)).statusCode).toBe(404);
		expect((await ctx.app.inject({ method: 'GET', url: `/public/campaigns/${tenant.campaignSlug}/app-draws/1/prizes/1/candidates.txt`, headers: headers(other) })).statusCode).toBe(404);
	});
});

describe('simultaneous tiradas and the rules around them', () => {
	it('two simultaneous clicks on one prize make one commitment and one reveal', async () => {
		const tenant = await appTenant('prize-race', 3);
		const ids = await prizeIds(tenant);
		const api = client(tenant);
		await api.toAwarding();
		const [first, second] = await Promise.all([api.draw(ids.cash), api.draw(ids.cash)]);
		// The second one resumes the first one's tirada (200 once it is revealed), or finds nothing left to draw.
		const statuses = [first.statusCode, second.statusCode].sort();
		expect([[200, 201], [201, 409]]).toContainEqual(statuses);
		const revealed = [first, second].filter((response) => response.statusCode !== 409);
		if (revealed.length === 2) expect(first.json().picks).toEqual(second.json().picks);
		const after = await footprint(tenant);
		expect(after).toMatchObject({ commits: 1, reveals: 1, awards: 5 });
	});

	it('fills what the coupons allow; the rest waits for a void declaration, and the campaign cannot finish meanwhile', async () => {
		// Two coupons for the moto and five cash units.
		const tenant = await appTenant('prize-few', 1);
		const ids = await prizeIds(tenant);
		const api = client(tenant);
		await api.toAwarding();
		// A pending app unit keeps the campaign from finishing, like a vacant Quiniela unit, and is drawn first.
		expectRefusal(await api.request('POST', `/admin/campaigns/${tenant.campaignId}/transition`, { to: 'fulfilled' }, tenant.ownerId), 409, 'prizes_vacant', 'Hay premios vacantes: sortealos en la aplicación');
		expectRefusal(await api.request('POST', `/admin/campaigns/${tenant.campaignId}/awards/${ids.cash}/slots/1/void`, { reason: 'Nadie lo puede ganar' }), 409, 'app_draw_possible');
		const cash = await api.draw(ids.cash);
		expect(cash.statusCode, cash.body).toBe(201);
		expect(cash.json().picks.map((pick: { slot: number }) => pick.slot)).toEqual([1, 2]);
		expect((await api.prizes()).json().prizes[1]).toMatchObject({ state: 'pending', pendingUnits: [3, 4, 5], reason: 'No quedan cupones sin premio para sortear este premio' });
		const before = await footprint(tenant);
		expectRefusal(await api.draw(ids.moto), 409, 'no_candidates', 'No quedan cupones sin premio para sortear este premio');
		expect(await footprint(tenant)).toEqual(before);
		// With no coupon left, a pending unit is declared void, as a vacancy.
		const { prizes } = await api.board();
		expect(prizes.find((prize: { id: string }) => prize.id === ids.cash).slots[2].canDeclareVoid).toBe(true);
		const declared = await api.request('POST', `/admin/campaigns/${tenant.campaignId}/awards/${ids.cash}/slots/3/void`, { reason: 'No quedan cupones sin premio' });
		expect(declared.statusCode, declared.body).toBe(200);
		expect((await api.prizes()).json().prizes[1].pendingUnits).toEqual([4, 5]);
	});

	it('refuses an awarding campaign without its round manifest, writing nothing', async () => {
		const tenant = await appTenant('prize-nomanifest', 1);
		const ids = await prizeIds(tenant);
		await ctx.db.withTenant(tenant.id, (tx) => tx.update(s.campaigns).set({ status: 'awarding' }).where(eq(s.campaigns.id, tenant.campaignId)));
		const before = await footprint(tenant);
		expectRefusal(await client(tenant).draw(ids.cash), 409, 'manifest_required', 'Falta el manifiesto publicado');
		expect(await footprint(tenant)).toEqual(before);
	});
});
