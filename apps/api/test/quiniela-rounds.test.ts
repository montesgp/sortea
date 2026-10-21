import { asc, count, eq, schema as s } from '@sortea/db';
import { parseManifest } from '@sortea/domain';
import { sha256Hex } from '@sortea/domain/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminHeaders, createTenant, createTestContext, headers, openCampaign, placeOrder, webhookRequest, type TenantFixture, type TestContext } from './helpers';

/**
 * ADR 0014 §5: a quiniela prize nobody matched stays vacant, the campaign
 * reopens for a new round with a new closing date, every coupon keeps
 * playing, the round closes with its own manifest and its own draw decides
 * only what is still vacant.
 */
let ctx: TestContext;
let tenant: TenantFixture;

interface Board {
	campaign: { round: number };
	prizes: { id: string; kind: string; slots: { slot: number; state: string; awards: { id: string; role: string; entryNumber: number; active: boolean }[] }[] }[];
}

const twenty = (...head: number[]) => [...head, ...Array.from({ length: 20 - head.length }, (_, index) => 1_000 + index)];
const evidenceUrl = 'https://loteria.example/extracto.pdf';

function client(target: TenantFixture, context = ctx) {
	const as = async (userId = target.ownerId) => adminHeaders(context, target, userId);
	const request = async (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown, userId?: string) =>
		context.app.inject({ method, url, headers: await as(userId), payload: payload as Record<string, unknown> | undefined });
	const campaign = `/admin/campaigns/${target.campaignId}`;
	return {
		request,
		reopen: (payload: unknown, userId?: string) => request('POST', `${campaign}/reopen`, payload, userId),
		transition: (to: string) => request('POST', `${campaign}/transition`, { to }),
		close: () => request('POST', `${campaign}/close`),
		event: (kind: string, title: string) => request('POST', `${campaign}/draw-events`, { kind, title, occurredAt: context.clock.now.toISOString() }, target.operatorId),
		board: async () => (await request('GET', `${campaign}/awards`, undefined, target.operatorId)).json() as Board,
		preview: (body: unknown) => request('POST', `${campaign}/quiniela/preview`, body, target.operatorId),
		async draw(body: Record<string, unknown>) {
			const previewed = await request('POST', `${campaign}/quiniela/preview`, body, target.operatorId);
			expect(previewed.statusCode, previewed.body).toBe(200);
			return request('POST', `${campaign}/quiniela`, { ...body, digest: previewed.json().digest }, target.operatorId);
		},
		async settle(awardId: string) {
			expect((await request('POST', `/admin/awards/${awardId}/decision`, { decision: 'accepted' }, target.operatorId)).statusCode).toBe(200);
			const delivered = await request('PUT', `/admin/awards/${awardId}/fulfillment`, { status: 'delivered' }, target.operatorId);
			expect(delivered.statusCode, delivered.body).toBe(200);
		},
		publicCampaign: async () => (await context.app.inject({ method: 'GET', url: `/public/campaigns/${target.campaignSlug}`, headers: headers(target) })).json(),
		transparency: async () => (await context.app.inject({ method: 'GET', url: `/public/campaigns/${target.campaignSlug}/transparency`, headers: headers(target) })).json()
	};
}

async function buy(target: TenantFixture, orders: number, from = 0, context = ctx) {
	const references: string[] = [];
	for (let index = from; index < from + orders; index++) {
		context.clock.now = new Date(context.clock.now.getTime() + 60_000);
		// Two coupons per order.
		const order = await placeOrder(context, target, {
			buyer: { documentType: 'DNI', documentNumber: String(32_000_000 + index), firstName: `Persona${index}`, lastName: 'Prueba', email: `ronda${index}@example.com`, province: 'Salta', city: 'Salta' }
		});
		const payment = context.simulator.pay(order.preferenceId, 'approved');
		expect((await context.app.inject(webhookRequest(target, payment.id))).statusCode).toBe(200);
		references.push(order.reference);
	}
	return references;
}

async function setPrize(target: TenantFixture, kind: string, patch: Record<string, unknown>, context = ctx) {
	const auth = await adminHeaders(context, target);
	const { prizes } = (await context.app.inject({ method: 'GET', url: `/admin/campaigns/${target.campaignId}/prizes`, headers: auth })).json() as { prizes: { id: string; kind: string }[] };
	const response = await context.app.inject({ method: 'PATCH', url: `/admin/prizes/${prizes.find((prize) => prize.kind === kind)!.id}`, headers: auth, payload: patch });
	expect(response.statusCode, response.body).toBe(200);
}

/** Campaign row, log and audit counts: what a refused reopen must leave alone. */
async function footprint(target: TenantFixture) {
	return ctx.db.withTenant(target.id, async (tx) => {
		const [campaign] = await tx.select({ status: s.campaigns.status, round: s.campaigns.currentRound, closesAt: s.campaigns.closesAt, drawAt: s.campaigns.drawAt }).from(s.campaigns).where(eq(s.campaigns.id, target.campaignId));
		const [[events], [audits]] = await Promise.all([tx.select({ value: count() }).from(s.drawEvents), tx.select({ value: count() }).from(s.auditEvents)]);
		return { ...campaign!, events: events!.value, audits: audits!.value };
	});
}

const manifests = (target: TenantFixture) =>
	ctx.db.withTenant(target.id, (tx) => tx.select().from(s.drawManifests).where(eq(s.drawManifests.campaignId, target.campaignId)).orderBy(asc(s.drawManifests.round)));

async function awardRows(target: TenantFixture) {
	const rows = await ctx.db.withTenant(target.id, (tx) =>
		tx
			.select({ kind: s.prizes.kind, slot: s.prizeAwards.slot, role: s.prizeAwards.role, round: s.prizeAwards.round, entryNumber: s.participationEntries.entryNumber })
			.from(s.prizeAwards)
			.innerJoin(s.prizes, eq(s.prizes.id, s.prizeAwards.prizeId))
			.innerJoin(s.participationEntries, eq(s.participationEntries.id, s.prizeAwards.entryId))
	);
	return rows.map((row) => `r${row.round} ${row.kind}#${row.slot} ${row.role} ${row.entryNumber}`).sort();
}

/** A tenant whose campaign is open with only the given prizes drawn by the Quiniela, one unit each, no alternates. */
async function quinielaTenant(label: string, quiniela: string[], context = ctx) {
	const target = await createTenant(context, label);
	context.clock.now = new Date('2026-10-25T15:00:00Z');
	await setPrize(target, 'cash', { quantity: 1, alternatesCount: 0, position: 1, ...(quiniela.includes('cash') ? { mechanism: 'quiniela' } : {}) }, context);
	await setPrize(target, 'vehicle', { alternatesCount: 0, position: 2, ...(quiniela.includes('vehicle') ? { mechanism: 'quiniela' } : {}) }, context);
	await setPrize(target, 'product', { quantity: 1, alternatesCount: 0, position: 3 }, context);
	return target;
}

async function toAwarding(target: TenantFixture, at: string, context = ctx) {
	const api = client(target, context);
	context.clock.now = new Date(at);
	const closed = await api.close();
	expect(closed.statusCode, closed.body).toBe(200);
	expect((await api.transition('awarding')).statusCode).toBe(200);
}

beforeAll(async () => {
	ctx = await createTestContext();
	// The cash prize goes first, then the moto, both from the Quiniela; the kit is recorded by hand.
	tenant = await quinielaTenant('rondas', ['cash', 'vehicle']);
	await openCampaign(ctx, tenant);
	// Coupons 0000-0003.
	await buy(tenant, 2);
});
afterAll(() => ctx.close());

describe('round 1 and its vacancy', () => {
	it('closes round 1 and refuses to reopen before its draw', async () => {
		await toAwarding(tenant, '2026-11-29T01:00:00Z');
		ctx.clock.now = new Date('2026-11-30T12:00:00Z');
		const api = client(tenant);
		const before = await footprint(tenant);
		const refused = await api.reopen({ closesAt: '2026-12-20T23:00:00Z' });
		expect(refused.statusCode).toBe(409);
		expect(refused.json().error).toMatchObject({ code: 'draw_pending', message: 'Primero registrá el sorteo de la Quiniela de esta ronda' });
		expect(await footprint(tenant)).toEqual(before);
		const [manifest] = await manifests(tenant);
		expect(manifest).toMatchObject({ round: 1, eligibleCount: 4 });
		expect(parseManifest(manifest!.content).header).toMatchObject({ format: 'sortea.manifest.v2', round: 1, entryDigits: 4 });
	});

	it('draws round 1: the cash prize matches, the moto stays vacant', async () => {
		const api = client(tenant);
		expect((await api.event('mechanism_recorded', 'Kit: acta notarial')).statusCode).toBe(200);
		const board = await api.board();
		const kit = await api.request('PUT', `/admin/campaigns/${tenant.campaignId}/awards/${board.prizes.find((prize) => prize.kind === 'product')!.id}/slots/1`, { winner: 0, alternates: [] }, tenant.operatorId);
		expect(kit.statusCode, kit.body).toBe(200);

		const confirmed = await api.draw({ source: 'Quiniela de la Ciudad, Nocturna', drawnAt: '2026-11-30T00:00:00Z', extracts: twenty(2), evidenceUrl });
		expect(confirmed.statusCode, confirmed.body).toBe(200);
		expect(await awardRows(tenant)).toEqual(['r1 cash#1 winner 2', 'r1 product#1 winner 0']);
		const data = confirmed.json() as Board;
		expect(data.campaign.round).toBe(1);
		expect(data.prizes.find((prize) => prize.kind === 'vehicle')!.slots.map((slot) => slot.state)).toEqual(['vacant']);
	});

	it('keeps the campaign from fulfilled while the moto is vacant, even with everything else delivered', async () => {
		const api = client(tenant);
		const board = await api.board();
		for (const kind of ['cash', 'product']) await api.settle(board.prizes.find((prize) => prize.kind === kind)!.slots[0]!.awards[0]!.id);
		const refused = await api.transition('fulfilled');
		expect(refused.statusCode).toBe(409);
		expect(refused.json().error).toMatchObject({ code: 'prizes_vacant', message: 'Hay premios vacantes: reabrí la campaña para una nueva ronda' });
		const detail = (await api.request('GET', `/admin/campaigns/${tenant.campaignId}`)).json();
		// A new round waits for this round's results, so they stay attached to it.
		expect(detail).toMatchObject({ currentRound: 1, canReopen: false, reopenBlocked: 'Publicá los resultados de esta ronda antes de abrir la siguiente', vacantSlots: [{ prize: 'Moto', slot: 1 }] });
		expect((await api.event('result_published', 'Resultados de la ronda 1')).statusCode).toBe(200);
		expect((await api.request('GET', `/admin/campaigns/${tenant.campaignId}`)).json()).toMatchObject({ canReopen: true, reopenBlocked: null });
	});
});

describe('reopening for round 2', () => {
	it('is its own action: the plain transition never goes back to open', async () => {
		const api = client(tenant);
		const before = await footprint(tenant);
		expect((await api.transition('open')).json().error.code).toBe('invalid_transition');
		// Operators record results; reopening a campaign is a campaign manager's call.
		expect((await api.reopen({ closesAt: '2026-12-20T23:00:00Z' }, tenant.operatorId)).statusCode).toBe(403);
		expect(await footprint(tenant)).toEqual(before);
	});

	it('refuses a closing date that is not ahead, and a draw date before it', async () => {
		const api = client(tenant);
		const before = await footprint(tenant);
		const message = 'Revisá las fechas: el nuevo cierre tiene que ser futuro y el sorteo, posterior al cierre';
		for (const payload of [
			{ closesAt: '2026-11-30T11:00:00Z' },
			{ closesAt: ctx.clock.now.toISOString() },
			{ closesAt: '2026-12-20T23:00:00Z', drawAt: '2026-12-20T22:00:00Z' }
		]) {
			const refused = await api.reopen(payload);
			expect(refused.statusCode, JSON.stringify(payload)).toBe(409);
			expect(refused.json().error).toMatchObject({ code: 'invalid_schedule', message });
		}
		expect((await api.reopen({})).json().error.code).toBe('invalid_request');
		expect(await footprint(tenant)).toEqual(before);
	});

	it('refuses while the compliance gate is closed', async () => {
		const api = client(tenant);
		// Approvals are frozen by the API after opening; only a data repair can revoke one.
		const setLegal = (status: 'approved' | 'rejected') =>
			ctx.db.withTenant(tenant.id, (tx) => tx.update(s.campaignApprovals).set({ status }).where(eq(s.campaignApprovals.kind, 'legal')));
		await setLegal('rejected');
		try {
			const before = await footprint(tenant);
			const refused = await api.reopen({ closesAt: '2026-12-20T23:00:00Z' });
			expect(refused.statusCode).toBe(409);
			expect(refused.json().error).toMatchObject({ code: 'compliance_gate_closed', details: { missing: [], rejected: ['legal'] } });
			expect(await footprint(tenant)).toEqual(before);
		} finally {
			await setLegal('approved');
		}
	});

	it('reopens: round 2, the new dates, a public announcement of what is vacant, the rules unchanged', async () => {
		const api = client(tenant);
		const rulesBefore = await ctx.db.withTenant(tenant.id, (tx) => tx.select().from(s.campaignRuleVersions));
		const response = await api.reopen({ closesAt: '2026-12-20T23:00:00Z', drawAt: '2026-12-22T00:00:00Z' });
		expect(response.statusCode, response.body).toBe(200);
		expect(response.json()).toMatchObject({ status: 'open', currentRound: 2, closesAt: '2026-12-20T23:00:00.000Z', drawAt: '2026-12-22T00:00:00.000Z', canReopen: false });
		expect(await ctx.db.withTenant(tenant.id, (tx) => tx.select().from(s.campaignRuleVersions))).toEqual(rulesBefore);

		const [event] = await ctx.db.withTenant(tenant.id, (tx) => tx.select().from(s.drawEvents).where(eq(s.drawEvents.kind, 'round_opened')));
		expect(event).toMatchObject({ round: 2, title: 'Ronda 2 abierta', detail: 'Cierra el 20/12/2026 a las 20:00. Premios vacantes que se sortean en esta ronda: Moto.' });
		const [auditRow] = await ctx.db.withTenant(tenant.id, (tx) => tx.select().from(s.auditEvents).where(eq(s.auditEvents.action, 'campaign.reopened')));
		expect(auditRow).toMatchObject({ actorId: tenant.ownerId, targetId: tenant.campaignId, metadata: { round: 2, closesAt: '2026-12-20T23:00:00.000Z', drawAt: '2026-12-22T00:00:00.000Z', vacant: [{ prize: 'Moto', slot: 1 }] } });

		const page = await api.publicCampaign();
		expect(page).toMatchObject({ status: 'open', round: 2, closesAt: '2026-12-20T23:00:00.000Z', acceptingParticipations: true, carriedOver: [{ prize: 'Moto', slot: 1 }] });
		expect((await api.reopen({ closesAt: '2026-12-30T23:00:00Z' })).json().error.code).toBe('invalid_transition');
	});

	it('does not publish results of a round before its draw', async () => {
		const refused = await client(tenant).event('result_published', 'Resultados de la ronda 2');
		expect(refused.statusCode).toBe(409);
		expect(refused.json().error).toMatchObject({ code: 'draw_pending', message: 'Los resultados de esta ronda se publican después de registrar su sorteo de la Quiniela' });
	});

	it('numbers the new purchases after the coupons of round 1, in the same pool', async () => {
		ctx.clock.now = new Date('2026-12-01T12:00:00Z');
		const [reference] = await buy(tenant, 1, 10);
		const entries = await ctx.db.withTenant(tenant.id, (tx) =>
			tx.select({ number: s.participationEntries.entryNumber }).from(s.participationEntries).innerJoin(s.orders, eq(s.orders.id, s.participationEntries.orderId)).where(eq(s.orders.reference, reference!)).orderBy(asc(s.participationEntries.entryNumber))
		);
		expect(entries.map((entry) => entry.number)).toEqual([4, 5]);
	});
});

describe('round 2', () => {
	it('closes with the same rule: not before closesAt + order TTL, then publishes the round 2 manifest with every coupon', async () => {
		const api = client(tenant);
		ctx.clock.now = new Date('2026-12-20T23:59:00Z');
		expect((await api.close()).json().error.code).toBe('payments_in_transit');
		const [round1] = await manifests(tenant);
		await toAwarding(tenant, '2026-12-21T00:00:00Z');
		const rows = await manifests(tenant);
		expect(rows.map((row) => [row.round, row.eligibleCount, row.voidCount])).toEqual([
			[1, 4, 0],
			[2, 6, 0]
		]);
		// Round 1's manifest is untouched; round 2 has its own hash over its own bytes.
		expect(rows[0]).toEqual(round1);
		expect(rows[1]!.sha256).toBe(sha256Hex(rows[1]!.content));
		expect(rows[1]!.sha256).not.toBe(rows[0]!.sha256);
		const manifest = parseManifest(rows[1]!.content);
		expect(manifest.header).toMatchObject({ format: 'sortea.manifest.v2', round: 2, entryDigits: 4, closedAt: '2026-12-20T23:00:00.000Z', eligibleCount: 6 });
		expect(manifest.entries.map((entry) => entry.entryNumber)).toEqual([0, 1, 2, 3, 4, 5]);
		const [event] = await ctx.db.withTenant(tenant.id, (tx) => tx.select().from(s.drawEvents).where(eq(s.drawEvents.round, 2)).orderBy(asc(s.drawEvents.createdAt)).offset(1));
		expect(event).toMatchObject({ kind: 'manifest_published', title: 'Lista de participaciones de la ronda 2 congelada y publicada' });
	});

	it('refuses a draw held before the round 2 manifest, even if it is after round 1', async () => {
		ctx.clock.now = new Date('2026-12-22T12:00:00Z');
		const refused = await client(tenant).preview({ source: 'Quiniela de la Ciudad, Nocturna', drawnAt: '2026-12-20T22:00:00Z', extracts: twenty(5), evidenceUrl });
		expect(refused.statusCode).toBe(409);
		expect(refused.json().error).toMatchObject({
			code: 'draw_before_manifest',
			message: 'El sorteo de la Quiniela tiene que ser posterior a la publicación del manifiesto (20/12/2026 21:00)'
		});
	});

	it('draws only the vacant moto, despite round 1 results being published, and never re-awards a coupon', async () => {
		const api = client(tenant);
		const body = { source: 'Quiniela de la Ciudad, Vespertina', drawnAt: '2026-12-21T21:00:00Z', extracts: twenty(2, 0, 5, 4), evidenceUrl };
		const previewed = (await api.preview(body)).json();
		expect(previewed.extracts.slice(0, 4).map((extract: { number: number; outcome: string }) => [extract.number, extract.outcome])).toEqual([
			[2, 'already_awarded'],
			[0, 'already_awarded'],
			[5, 'winner'],
			[4, 'spare']
		]);
		expect(previewed.slots.map((slot: { prizeTitle: string; winner: { entryNumber: number } | null }) => [slot.prizeTitle, slot.winner?.entryNumber])).toEqual([['Moto', 5]]);

		const confirmed = await api.draw(body);
		expect(confirmed.statusCode, confirmed.body).toBe(200);
		expect(await awardRows(tenant)).toEqual(['r1 cash#1 winner 2', 'r1 product#1 winner 0', 'r2 vehicle#1 winner 5']);
		const draws = await ctx.db.withTenant(tenant.id, (tx) => tx.select().from(s.quinielaDraws).orderBy(asc(s.quinielaDraws.round)));
		const rows = await manifests(tenant);
		expect(draws.map((draw) => [draw.round, draw.manifestSha256])).toEqual([
			[1, rows[0]!.sha256],
			[2, rows[1]!.sha256]
		]);
		expect((await api.preview(body)).json().error.code).toBe('draw_exists');
	});

	it('publishes each round on transparency: manifests, draws, and its awards and vacancies once its results are out', async () => {
		const api = client(tenant);
		const early = await api.transparency();
		expect(early.round).toBe(2);
		expect(early.manifests.map((manifest: { round: number; eligibleCount: number }) => [manifest.round, manifest.eligibleCount])).toEqual([
			[1, 4],
			[2, 6]
		]);
		expect(early.quinielaDraws.map((draw: { round: number; source: string; manifestSha256: string }) => [draw.round, draw.source])).toEqual([
			[1, 'Quiniela de la Ciudad, Nocturna'],
			[2, 'Quiniela de la Ciudad, Vespertina']
		]);
		expect(early.timeline.find((event: { kind: string }) => event.kind === 'round_opened')).toMatchObject({ round: 2, title: 'Ronda 2 abierta' });
		// Round 2's award stays private until its results are published.
		expect(early.awards.map((award: { round: number; prize: string }) => [award.round, award.prize])).toEqual([
			[1, '$100.000'],
			[1, 'Kit']
		]);
		expect(early.vacantSlots).toEqual([{ round: 1, prize: 'Moto', slot: 1 }]);

		expect((await api.event('result_published', 'Resultados de la ronda 2')).statusCode).toBe(200);
		const published = await api.transparency();
		expect(published.awards.find((award: { prize: string }) => award.prize === 'Moto')).toMatchObject({ round: 2, entryNumber: 5, extractPosition: 3 });
		expect(published.vacantSlots).toEqual([{ round: 1, prize: 'Moto', slot: 1 }]);

		// Each round's manifest downloads byte for byte; the latest one by default.
		const rows = await manifests(tenant);
		const download = async (query: string) => ctx.app.inject({ method: 'GET', url: `/public/campaigns/${tenant.campaignSlug}/manifest${query}`, headers: headers(tenant) });
		const first = await download('?round=1');
		expect([first.body, first.headers['x-content-sha256']]).toEqual([rows[0]!.content, rows[0]!.sha256]);
		expect((await download('')).body).toBe(rows[1]!.content);
		expect((await download('?round=3')).statusCode).toBe(404);
	});

	it('reaches fulfilled once nothing is vacant and every unit is delivered', async () => {
		const api = client(tenant);
		const moto = (await api.board()).prizes.find((prize) => prize.kind === 'vehicle')!;
		await api.settle(moto.slots[0]!.awards[0]!.id);
		const done = await api.transition('fulfilled');
		expect(done.statusCode, done.body).toBe(200);
		expect(done.json().status).toBe('fulfilled');
	});
});

describe('no vacancy, no new round', () => {
	it('refuses to reopen when every quiniela unit got a winner', async () => {
		const target = await quinielaTenant('rondas-completas', ['vehicle']);
		await openCampaign(ctx, target);
		await buy(target, 1, 20);
		await toAwarding(target, '2026-11-29T01:00:00Z');
		ctx.clock.now = new Date('2026-11-30T12:00:00Z');
		const api = client(target);
		expect((await api.draw({ source: 'Quiniela de la Ciudad, Nocturna', drawnAt: '2026-11-30T00:00:00Z', extracts: twenty(1), evidenceUrl })).statusCode).toBe(200);
		const before = await footprint(target);
		const refused = await api.reopen({ closesAt: '2026-12-20T23:00:00Z' });
		expect(refused.statusCode).toBe(409);
		expect(refused.json().error).toMatchObject({ code: 'no_vacancy', message: 'No hay premios vacantes: la campaña no necesita otra ronda' });
		expect(await footprint(target)).toEqual(before);
	});
});

describe('the local compliance demo mode (ADR 0013)', () => {
	let demo: TestContext;
	beforeAll(async () => {
		demo = await createTestContext({ complianceDemo: true });
	});
	afterAll(() => demo.close());

	it('lets a demo campaign reopen with pending approvals only while the mode is on', async () => {
		const target = await quinielaTenant('rondas-demo', ['vehicle'], demo);
		await demo.db.withTenant(target.id, (tx) => tx.update(s.campaigns).set({ isDemo: true }).where(eq(s.campaigns.id, target.campaignId)));
		expect((await client(target, demo).transition('open')).statusCode).toBe(200);
		await buy(target, 1, 30, demo);
		await toAwarding(target, '2026-11-29T01:00:00Z', demo);
		demo.clock.now = new Date('2026-11-30T12:00:00Z');
		ctx.clock.now = demo.clock.now;
		expect((await client(target, demo).draw({ source: 'Quiniela de la Ciudad, Nocturna', drawnAt: '2026-11-30T00:00:00Z', extracts: twenty(), evidenceUrl })).statusCode).toBe(200);
		expect((await client(target, demo).event('result_published', 'Resultados de la ronda 1')).statusCode).toBe(200);

		// Without the mode the same campaign meets the normal gate, and its approvals are pending.
		const closed = await client(target, ctx).reopen({ closesAt: '2026-12-20T23:00:00Z' });
		expect(closed.statusCode).toBe(409);
		expect(closed.json().error).toMatchObject({ code: 'compliance_gate_closed', details: { missing: ['legal', 'psp'], rejected: [] } });

		const reopened = await client(target, demo).reopen({ closesAt: '2026-12-20T23:00:00Z' });
		expect(reopened.statusCode, reopened.body).toBe(200);
		expect(reopened.json()).toMatchObject({ status: 'open', currentRound: 2, gate: { allowed: true, demo: true } });
		const approvals = await demo.db.withTenant(target.id, (tx) => tx.select({ status: s.campaignApprovals.status }).from(s.campaignApprovals));
		expect(approvals.map((row) => row.status)).toEqual(['pending', 'pending']);
	});
});

/**
 * Round 1 drawn: the kit by hand (winner 0000, alternate 0001), then the
 * Quiniela with 0002 first: the cash prize goes to 0002 and the moto stays
 * vacant. Coupons 0000-0003 are sold.
 */
async function roundOneDrawn(label: string) {
	const target = await quinielaTenant(label, ['cash', 'vehicle']);
	await setPrize(target, 'product', { alternatesCount: 1 });
	await openCampaign(ctx, target);
	await buy(target, 2, 40);
	await toAwarding(target, '2026-11-29T01:00:00Z');
	ctx.clock.now = new Date('2026-11-30T12:00:00Z');
	const api = client(target);
	expect((await api.event('mechanism_recorded', 'Kit: acta notarial')).statusCode).toBe(200);
	const kitId = (await api.board()).prizes.find((prize) => prize.kind === 'product')!.id;
	const kit = await api.request('PUT', `/admin/campaigns/${target.campaignId}/awards/${kitId}/slots/1`, { winner: 0, alternates: [1] }, target.operatorId);
	expect(kit.statusCode, kit.body).toBe(200);
	expect((await api.draw({ source: 'Quiniela de la Ciudad, Nocturna', drawnAt: '2026-11-30T00:00:00Z', extracts: twenty(2), evidenceUrl })).statusCode).toBe(200);
	return { target, api, kitId };
}

const awardOf = (board: Board, kind: string, role = 'winner') => board.prizes.find((prize) => prize.kind === kind)!.slots[0]!.awards.find((award) => award.role === role)!;

describe('a round is published before the next one opens (S4)', () => {
	it('refuses to reopen with the round results pending, and keeps round 1 public after round 2 publishes', async () => {
		const { target, api, kitId } = await roundOneDrawn('rondas-publicadas');
		const before = await footprint(target);
		const refused = await api.reopen({ closesAt: '2026-12-20T23:00:00Z' });
		expect(refused.statusCode).toBe(409);
		expect(refused.json().error).toMatchObject({ code: 'results_pending', message: 'Publicá los resultados de esta ronda antes de abrir la siguiente' });
		expect(await footprint(target)).toEqual(before);

		expect((await api.event('result_published', 'Resultados de la ronda 1')).statusCode).toBe(200);
		expect((await api.reopen({ closesAt: '2026-12-20T23:00:00Z' })).statusCode).toBe(200);
		await toAwarding(target, '2026-12-21T00:00:00Z');

		// A round 1 manual result cannot be recorded again in round 2, against round 2's manifest.
		const kit = await api.request('PUT', `/admin/campaigns/${target.campaignId}/awards/${kitId}/slots/1`, { winner: 3, alternates: [] }, target.operatorId);
		expect(kit.statusCode).toBe(409);
		expect(kit.json().error.code).toBe('slot_locked');

		ctx.clock.now = new Date('2026-12-22T12:00:00Z');
		expect((await api.draw({ source: 'Quiniela de la Ciudad, Vespertina', drawnAt: '2026-12-21T21:00:00Z', extracts: twenty(3), evidenceUrl })).statusCode).toBe(200);
		expect((await api.event('result_published', 'Resultados de la ronda 2')).statusCode).toBe(200);
		const published = await api.transparency();
		expect(published.awards.map((award: { round: number; prize: string; entryNumber: number }) => [award.round, award.prize, award.entryNumber])).toEqual([
			[1, '$100.000', 2],
			[2, 'Moto', 3],
			[1, 'Kit', 0]
		]);
		expect(published.vacantSlots).toEqual([{ round: 1, prize: 'Moto', slot: 1 }]);
		expect(await awardRows(target)).toEqual(['r1 cash#1 winner 2', 'r1 product#1 alternate 1', 'r1 product#1 winner 0', 'r2 vehicle#1 winner 3']);
	});
});

describe('earlier rounds keep their decisions and deliveries going', () => {
	it('decides and delivers round 1 awards while round 2 is open and closed, within round 1', async () => {
		const { target, api } = await roundOneDrawn('rondas-decisiones');
		expect((await api.event('result_published', 'Resultados de la ronda 1')).statusCode).toBe(200);
		expect((await api.reopen({ closesAt: '2026-12-20T23:00:00Z' })).statusCode).toBe(200);

		// Round 2 is open: the round 1 cash winner is accepted, the kit winner declined and its round 1 alternate takes the slot.
		let board = await api.board();
		const cash = awardOf(board, 'cash');
		const accepted = await api.request('POST', `/admin/awards/${cash.id}/decision`, { decision: 'accepted' }, target.operatorId);
		expect(accepted.statusCode, accepted.body).toBe(200);
		const declined = await api.request('POST', `/admin/awards/${awardOf(board, 'product').id}/decision`, { decision: 'declined', notes: 'No respondió en el plazo de las bases' }, target.operatorId);
		expect(declined.statusCode, declined.body).toBe(200);
		board = declined.json() as Board;
		const active = board.prizes.find((prize) => prize.kind === 'product')!.slots[0]!.awards.find((award) => award.active)!;
		expect([active.role, active.entryNumber]).toEqual(['alternate', 1]);
		expect((await api.request('PUT', `/admin/awards/${cash.id}/fulfillment`, { status: 'scheduled', scheduledFor: '2026-12-05T15:00:00Z' }, target.operatorId)).statusCode).toBe(200);

		// Round 2 is closed: the delivery and the alternate's decision go on.
		ctx.clock.now = new Date('2026-12-21T00:00:00Z');
		expect((await api.close()).statusCode).toBe(200);
		const delivered = await api.request('PUT', `/admin/awards/${cash.id}/fulfillment`, { status: 'delivered' }, target.operatorId);
		expect(delivered.statusCode, delivered.body).toBe(200);
		expect((await api.request('POST', `/admin/awards/${active.id}/decision`, { decision: 'accepted' }, target.operatorId)).statusCode).toBe(200);

		// Round 2's own award follows its round: decided once the campaign is awarding, before its results are published.
		expect((await api.transition('awarding')).statusCode).toBe(200);
		ctx.clock.now = new Date('2026-12-22T12:00:00Z');
		expect((await api.draw({ source: 'Quiniela de la Ciudad, Vespertina', drawnAt: '2026-12-21T21:00:00Z', extracts: twenty(3), evidenceUrl })).statusCode).toBe(200);
		const moto = awardOf(await api.board(), 'vehicle');
		expect((await api.request('POST', `/admin/awards/${moto.id}/decision`, { decision: 'accepted' }, target.operatorId)).statusCode).toBe(200);
	});

	it('keeps a current round award frozen outside awarding', async () => {
		const { target, api } = await roundOneDrawn('rondas-actual');
		expect((await api.event('result_published', 'Resultados de la ronda 1')).statusCode).toBe(200);
		expect((await api.reopen({ closesAt: '2026-12-20T23:00:00Z' })).statusCode).toBe(200);
		await toAwarding(target, '2026-12-21T00:00:00Z');
		ctx.clock.now = new Date('2026-12-22T12:00:00Z');
		expect((await api.draw({ source: 'Quiniela de la Ciudad, Vespertina', drawnAt: '2026-12-21T21:00:00Z', extracts: twenty(3), evidenceUrl })).statusCode).toBe(200);
		const moto = awardOf(await api.board(), 'vehicle');
		// Only a data repair takes an awarding campaign back to closed; the round 2 award then waits.
		await ctx.db.withTenant(target.id, (tx) => tx.update(s.campaigns).set({ status: 'closed' }).where(eq(s.campaigns.id, target.campaignId)));
		const refused = await api.request('POST', `/admin/awards/${moto.id}/decision`, { decision: 'accepted' }, target.operatorId);
		expect(refused.statusCode).toBe(409);
		expect(refused.json().error.code).toBe('not_awarding');
	});
});

describe('S3: concurrent confirms of a round draw award once; earlier alternates are skipped', () => {
	it('awards once and skips coupons already awarded in round 1', async () => {
		const { target, api } = await roundOneDrawn('rondas-carrera');
		expect((await api.event('result_published', 'Resultados de la ronda 1')).statusCode).toBe(200);
		expect((await api.reopen({ closesAt: '2026-12-20T23:00:00Z' })).statusCode).toBe(200);
		await toAwarding(target, '2026-12-21T00:00:00Z');
		ctx.clock.now = new Date('2026-12-22T12:00:00Z');
		const body = { source: 'Quiniela de la Ciudad, Vespertina', drawnAt: '2026-12-21T21:00:00Z', extracts: twenty(1, 3), evidenceUrl };
		const previewed = (await api.preview(body)).json();
		expect(previewed.extracts.slice(0, 2).map((extract: { number: number; outcome: string }) => [extract.number, extract.outcome])).toEqual([
			[1, 'already_awarded'],
			[3, 'winner']
		]);
		const confirm = () => api.request('POST', `/admin/campaigns/${target.campaignId}/quiniela`, { ...body, digest: previewed.digest }, target.operatorId);
		const results = await Promise.all([confirm(), confirm()]);
		expect(results.map((response) => response.statusCode).sort()).toEqual([200, 409]);
		const draws = await ctx.db.withTenant(target.id, (tx) => tx.select({ round: s.quinielaDraws.round }).from(s.quinielaDraws).orderBy(asc(s.quinielaDraws.round)));
		expect(draws.map((draw) => draw.round)).toEqual([1, 2]);
		expect(await awardRows(target)).toEqual(['r1 cash#1 winner 2', 'r1 product#1 alternate 1', 'r1 product#1 winner 0', 'r2 vehicle#1 winner 3']);
	});
});
