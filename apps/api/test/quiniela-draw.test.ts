import { randomUUID } from 'node:crypto';
import { and, count, eq, schema as s } from '@sortea/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminHeaders, createTenant, createTestContext, headers, openCampaign, placeOrder, webhookRequest, type TenantFixture, type TestContext } from './helpers';

/**
 * ADR 0014 §2-§4: prizes decided by the 20 extracts of an official Quiniela
 * draw. The admin previews the matching, then confirms it; confirming writes
 * the awards of the `quiniela` prizes and a public record of the draw.
 */
let ctx: TestContext;
let tenant: TenantFixture;
const financeId = randomUUID();

interface Board {
	prizes: { id: string; kind: string; mechanism: string; slots: { slot: number; state: string; canRecord: boolean; awards: { id: string; role: string; rank: number; entryNumber: number; active: boolean; notes: string | null }[] }[] }[];
	quinielaDraw: { source: string; drawDate: string; extracts: number[]; evidenceUrl: string } | null;
}

const asOwner = () => adminHeaders(ctx, tenant);
const asOperator = () => adminHeaders(ctx, tenant, tenant.operatorId);
const call = async (method: 'GET' | 'PUT' | 'POST' | 'PATCH', url: string, auth: Record<string, string>, payload?: unknown) =>
	ctx.app.inject({ method, url, headers: auth, payload: payload as Record<string, unknown> | undefined });

/** Padded to the official 20 with numbers nobody holds. */
const twenty = (...head: number[]) => [...head, ...Array.from({ length: 20 - head.length }, (_, index) => 1_000 + index)];
const draw = (overrides: Record<string, unknown> = {}) => ({
	source: 'Quiniela de la Ciudad, Nocturna',
	// 21:00 in Buenos Aires on the 29th, after the manifest was published on the 28th at 22:00.
	drawnAt: '2026-11-30T00:00:00.000Z',
	// 0000 matches coupon 0; 9999 nobody; the second 0000 repeats; 5 already won the kit by hand.
	extracts: twenty(9_999, 0, 0, 5, 1, 7, 3, 6, 2, 4),
	evidenceUrl: 'https://loteria.example/extracto-29-11.pdf',
	...overrides
});
const preview = async (campaignId = tenant.campaignId, body: unknown = draw()) => call('POST', `/admin/campaigns/${campaignId}/quiniela/preview`, await asOperator(), body);
/** The digest an operator's preview returns; a placeholder when the preview itself is refused. */
async function digestOf(target: TenantFixture, body: unknown): Promise<string> {
	const response = await ctx.app.inject({ method: 'POST', url: `/admin/campaigns/${target.campaignId}/quiniela/preview`, headers: await adminHeaders(ctx, target, target.operatorId), payload: body as Record<string, unknown> });
	return response.statusCode === 200 ? (response.json() as { digest: string }).digest : 'f'.repeat(64);
}
const confirm = async (body: Record<string, unknown> = draw(), auth?: Record<string, string>, digest?: string) =>
	call('POST', `/admin/campaigns/${tenant.campaignId}/quiniela`, auth ?? (await asOperator()), { ...body, digest: digest ?? (await digestOf(tenant, body)) });
const board = async (): Promise<Board> => (await call('GET', `/admin/campaigns/${tenant.campaignId}/awards`, await asOperator())).json();
const prizeOf = (data: Board, kind: string) => data.prizes.find((prize) => prize.kind === kind)!;

/** Everything a preview must leave alone. */
async function footprint(tenantId = tenant.id) {
	return ctx.db.withTenant(tenantId, async (tx) => {
		const [[awards], [draws], [events], [audits]] = await Promise.all([
			tx.select({ value: count() }).from(s.prizeAwards),
			tx.select({ value: count() }).from(s.quinielaDraws),
			tx.select({ value: count() }).from(s.drawEvents),
			tx.select({ value: count() }).from(s.auditEvents)
		]);
		return { awards: awards!.value, draws: draws!.value, events: events!.value, audits: audits!.value };
	});
}

async function awardRows(tenantId = tenant.id) {
	const rows = await ctx.db.withTenant(tenantId, (tx) =>
		tx
			.select({ kind: s.prizes.kind, slot: s.prizeAwards.slot, role: s.prizeAwards.role, rank: s.prizeAwards.rank, entryNumber: s.participationEntries.entryNumber })
			.from(s.prizeAwards)
			.innerJoin(s.prizes, eq(s.prizes.id, s.prizeAwards.prizeId))
			.innerJoin(s.participationEntries, eq(s.participationEntries.id, s.prizeAwards.entryId))
	);
	return rows.map((row) => `${row.kind}#${row.slot} ${row.role}${row.role === 'alternate' ? row.rank : ''} ${row.entryNumber}`).sort();
}

async function buy(target: TenantFixture, count: number) {
	for (let index = 0; index < count; index++) {
		ctx.clock.now = new Date(ctx.clock.now.getTime() + 60_000);
		// Two coupons per order: order i holds coupons 2i and 2i + 1.
		const order = await placeOrder(ctx, target, {
			buyer: { documentType: 'DNI', documentNumber: String(31_000_000 + index), firstName: `Persona${index}`, lastName: 'Prueba', email: `persona${index}@example.com`, province: 'Salta', city: 'Salta' }
		});
		const payment = ctx.simulator.pay(order.preferenceId, 'approved');
		expect((await ctx.app.inject(webhookRequest(target, payment.id))).statusCode).toBe(200);
	}
}

async function toAwarding(target: TenantFixture) {
	const auth = await adminHeaders(ctx, target);
	ctx.clock.now = new Date('2026-11-29T01:00:00Z');
	expect((await ctx.app.inject({ method: 'POST', url: `/admin/campaigns/${target.campaignId}/close`, headers: auth })).statusCode).toBe(200);
	expect((await ctx.app.inject({ method: 'POST', url: `/admin/campaigns/${target.campaignId}/transition`, headers: auth, payload: { to: 'awarding' } })).statusCode).toBe(200);
	// The draw of the 29th is over.
	ctx.clock.now = new Date('2026-11-30T12:00:00Z');
}

async function setMechanism(target: TenantFixture, kind: string, patch: Record<string, unknown>) {
	const auth = await adminHeaders(ctx, target);
	const { prizes } = (await ctx.app.inject({ method: 'GET', url: `/admin/campaigns/${target.campaignId}/prizes`, headers: auth })).json() as { prizes: { id: string; kind: string }[] };
	const response = await ctx.app.inject({ method: 'PATCH', url: `/admin/prizes/${prizes.find((prize) => prize.kind === kind)!.id}`, headers: auth, payload: patch });
	expect(response.statusCode, response.body).toBe(200);
	return response.json() as { prizes: { kind: string; mechanism: string; quantity: number }[] };
}

beforeAll(async () => {
	ctx = await createTestContext();
	tenant = await createTenant(ctx, 'quiniela');
	await ctx.db.withPlatform((db) => db.insert(s.organizationMembers).values({ organizationId: tenant.id, userId: financeId, email: `finance@${tenant.host}`, role: 'finance_manager' }));
});
afterAll(() => ctx.close());

describe('prize mechanism (ADR 0014 §2)', () => {
	it('is manual by default and editable with the other prize fields until the campaign opens', async () => {
		const { prizes } = (await call('GET', `/admin/campaigns/${tenant.campaignId}/prizes`, await asOwner())).json() as { prizes: { kind: string; mechanism: string }[] };
		expect(prizes.map((prize) => prize.mechanism)).toEqual(['manual', 'manual', 'manual']);

		// The moto (1 unit, 2 alternates) and 2 cash prizes (1 alternate each) come from the Quiniela; the 5 kits stay manual.
		await setMechanism(tenant, 'vehicle', { mechanism: 'quiniela' });
		const after = await setMechanism(tenant, 'cash', { mechanism: 'quiniela', quantity: 2 });
		expect(after.prizes.map((prize) => [prize.kind, prize.mechanism, prize.quantity])).toEqual([
			['vehicle', 'quiniela', 1],
			['cash', 'quiniela', 2],
			['product', 'manual', 5]
		]);
		expect((await call('PATCH', `/admin/prizes/${randomUUID()}`, await asOwner(), { mechanism: 'loteria' })).statusCode).toBe(400);

		await openCampaign(ctx, tenant);
		const { prizes: open } = (await call('GET', `/admin/campaigns/${tenant.campaignId}/prizes`, await asOwner())).json() as { prizes: { id: string; kind: string }[] };
		const locked = await call('PATCH', `/admin/prizes/${open.find((prize) => prize.kind === 'product')!.id}`, await asOwner(), { mechanism: 'quiniela' });
		expect(locked.json().error.code).toBe('prizes_locked');

		await buy(tenant, 4);
	});
});

describe('recording the Quiniela draw (ADR 0014 §3-§4)', () => {
	it('refuses before the campaign is awarding, and without a published manifest', async () => {
		expect((await preview()).json().error.code).toBe('not_awarding');
		expect((await confirm()).json().error.code).toBe('not_awarding');

		// An awarding campaign with no manifest (only reachable by data repair): still refused.
		const orphan = randomUUID();
		await ctx.db.withPlatform((db) =>
			db.insert(s.campaigns).values({ id: orphan, organizationId: tenant.id, slug: 'sin-manifiesto', title: 'Sin manifiesto', summary: 'S', status: 'awarding', timezone: 'UTC', opensAt: new Date('2026-10-01'), closesAt: new Date('2026-10-02') })
		);
		expect((await preview(orphan)).json().error.code).toBe('manifest_required');

		await toAwarding(tenant);
	});

	it('refuses a campaign whose coupons are not 4 digits: the extracts name 0000-9999', async () => {
		await ctx.db.withTenant(tenant.id, (tx) => tx.update(s.campaigns).set({ entryDigits: 5 }).where(eq(s.campaigns.id, tenant.campaignId)));
		try {
			const before = await footprint();
			const refused = await preview();
			expect(refused.statusCode).toBe(409);
			expect(refused.json().error).toMatchObject({ code: 'pool_not_quiniela', message: 'La Quiniela sortea números de 4 cifras y los cupones de esta campaña tienen 5' });
			expect((await confirm()).json().error.code).toBe('pool_not_quiniela');
			expect(await footprint()).toEqual(before);
		} finally {
			await ctx.db.withTenant(tenant.id, (tx) => tx.update(s.campaigns).set({ entryDigits: 4 }).where(eq(s.campaigns.id, tenant.campaignId)));
		}
	});

	it('validates the draw: 20 extracts of 4 digits, https evidence, a date and time', async () => {
		expect((await preview(tenant.campaignId, draw({ extracts: twenty().slice(1) }))).json().error.code).toBe('invalid_request');
		expect((await preview(tenant.campaignId, draw({ extracts: twenty(10_000) }))).json().error.code).toBe('invalid_request');
		expect((await preview(tenant.campaignId, draw({ evidenceUrl: 'http://loteria.example/x.pdf' }))).json().error.code).toBe('invalid_request');
		expect((await preview(tenant.campaignId, draw({ drawnAt: undefined }))).json().error.code).toBe('invalid_request');
	});

	it('refuses a draw held before the manifest was published, even on the day of the close, and a future one', async () => {
		const [manifest] = await ctx.db.withTenant(tenant.id, (tx) => tx.select().from(s.drawManifests).where(eq(s.drawManifests.campaignId, tenant.campaignId)));
		expect(manifest!.publishedAt).toEqual(new Date('2026-11-29T01:00:00Z'));
		const before = await footprint();
		const message = 'El sorteo de la Quiniela tiene que ser posterior a la publicación del manifiesto (28/11/2026 22:00)';
		// 14:00 on the 28th, the day of the close, before the 20:00 close: accepted before this rule.
		for (const drawnAt of ['2026-11-28T17:00:00Z', '2026-11-29T00:30:00Z', '2026-11-29T01:00:00Z']) {
			const refused = await preview(tenant.campaignId, draw({ drawnAt }));
			expect(refused.statusCode, drawnAt).toBe(409);
			expect(refused.json().error).toMatchObject({ code: 'draw_before_manifest', message });
			expect((await confirm(draw({ drawnAt }), undefined, 'f'.repeat(64))).json().error.code).toBe('draw_before_manifest');
		}
		const future = await preview(tenant.campaignId, draw({ drawnAt: '2026-11-30T12:00:01Z' }));
		expect(future.json().error).toMatchObject({ code: 'draw_in_future', message: 'La fecha del sorteo no puede ser futura' });
		// One minute after the publication is fine.
		expect((await preview(tenant.campaignId, draw({ drawnAt: '2026-11-29T01:01:00Z' }))).statusCode).toBe(200);
		expect(await footprint()).toEqual(before);
	});

	it('keeps manual prizes on the manual entry and quiniela prizes off it', async () => {
		expect((await call('POST', `/admin/campaigns/${tenant.campaignId}/draw-events`, await asOperator(), { kind: 'mechanism_recorded', title: 'Kits: acta notarial', occurredAt: ctx.clock.now.toISOString() })).statusCode).toBe(200);
		const data = await board();
		const kit = await call('PUT', `/admin/campaigns/${tenant.campaignId}/awards/${prizeOf(data, 'product').id}/slots/1`, await asOperator(), { winner: 5, alternates: [] });
		expect(kit.statusCode, kit.body).toBe(200);
		const moto = await call('PUT', `/admin/campaigns/${tenant.campaignId}/awards/${prizeOf(data, 'vehicle').id}/slots/1`, await asOperator(), { winner: 2, alternates: [] });
		expect(moto.statusCode).toBe(409);
		expect(moto.json().error).toMatchObject({ code: 'quiniela_prize', message: 'Este premio se define con el sorteo de la Quiniela, no se carga a mano' });
		expect(prizeOf(data, 'vehicle').slots[0]!.canRecord).toBe(false);
		expect(prizeOf(data, 'product').slots[0]!.canRecord).toBe(true);
	});

	it('previews the matching without writing anything', async () => {
		const before = await footprint();
		const response = await preview();
		expect(response.statusCode, response.body).toBe(200);
		const result = response.json() as {
			entryDigits: number;
			extracts: { position: number; number: number; outcome: string; prizeId: string | null; slot: number | null; rank: number | null }[];
			slots: { prizeId: string; prizeTitle: string; slot: number; winner: { entryNumber: number; extract: number } | null; alternates: { entryNumber: number; extract: number; rank: number }[] }[];
			vacant: unknown[];
			digest: string;
		};
		expect(result.entryDigits).toBe(4);
		expect(result.digest).toMatch(/^[0-9a-f]{64}$/);
		// The same data previews to the same digest.
		expect((await preview()).json().digest).toBe(result.digest);
		expect(result.extracts.slice(0, 11).map((extract) => [extract.position, extract.number, extract.outcome])).toEqual([
			[1, 9_999, 'no_match'],
			[2, 0, 'winner'],
			[3, 0, 'repeated'],
			[4, 5, 'already_awarded'],
			[5, 1, 'winner'],
			[6, 7, 'winner'],
			[7, 3, 'alternate'],
			[8, 6, 'alternate'],
			[9, 2, 'alternate'],
			[10, 4, 'alternate'],
			[11, 1_000, 'no_match']
		]);
		expect(result.slots.map((slot) => [slot.prizeTitle, slot.slot, slot.winner, slot.alternates])).toEqual([
			['Moto', 1, { entryNumber: 0, extract: 2 }, [{ entryNumber: 3, extract: 7, rank: 1 }, { entryNumber: 6, extract: 8, rank: 2 }]],
			['$100.000', 1, { entryNumber: 1, extract: 5 }, [{ entryNumber: 2, extract: 9, rank: 1 }]],
			['$100.000', 2, { entryNumber: 7, extract: 6 }, [{ entryNumber: 4, extract: 10, rank: 1 }]]
		]);
		expect(result.vacant).toEqual([]);
		expect(await footprint()).toEqual(before);
		expect((await board()).quinielaDraw).toBeNull();
	});

	it('lets operators confirm it but not finance, and only with the digest of a preview', async () => {
		const before = await footprint();
		expect((await confirm(draw(), await adminHeaders(ctx, tenant, financeId))).statusCode).toBe(403);
		expect((await call('POST', `/admin/campaigns/${tenant.campaignId}/quiniela`, await asOperator(), draw())).json().error.code).toBe('invalid_request');
		const forged = await confirm(draw(), undefined, 'f'.repeat(64));
		expect(forged.statusCode).toBe(409);
		expect(forged.json().error.code).toBe('preview_outdated');
		expect(await footprint()).toEqual(before);
	});

	it('confirms: writes exactly the quiniela awards and the public record of the draw', async () => {
		const before = await footprint();
		const response = await confirm();
		expect(response.statusCode, response.body).toBe(200);

		// Coupons 0 and 1 belong to the same buyer: two prizes, two independent coupons.
		expect(await awardRows()).toEqual(
			[
				'vehicle#1 winner 0',
				'vehicle#1 alternate1 3',
				'vehicle#1 alternate2 6',
				'cash#1 winner 1',
				'cash#1 alternate1 2',
				'cash#2 winner 7',
				'cash#2 alternate1 4',
				// The kit recorded by hand is untouched.
				'product#1 winner 5'
			].sort()
		);
		const after = await footprint();
		expect(after).toMatchObject({ awards: before.awards + 7, draws: 1, events: before.events + 1 });

		const [record] = await ctx.db.withTenant(tenant.id, (tx) => tx.select().from(s.quinielaDraws));
		const [manifest] = await ctx.db.withTenant(tenant.id, (tx) => tx.select().from(s.drawManifests).where(eq(s.drawManifests.campaignId, tenant.campaignId)));
		expect(record).toMatchObject({ round: 1, source: 'Quiniela de la Ciudad, Nocturna', drawnAt: new Date('2026-11-30T00:00:00Z'), extracts: draw().extracts, manifestSha256: manifest!.sha256, recordedBy: tenant.operatorId });

		const [event] = await ctx.db.withTenant(tenant.id, (tx) => tx.select().from(s.drawEvents).where(and(eq(s.drawEvents.campaignId, tenant.campaignId), eq(s.drawEvents.kind, 'quiniela_draw'))));
		expect(event).toMatchObject({ title: 'Sorteo de la Quiniela: Quiniela de la Ciudad, Nocturna', evidenceUrl: 'https://loteria.example/extracto-29-11.pdf' });
		expect(event!.detail).toBe(
			'Sorteo del 29/11/2026 a las 21:00. Extractos: 1.º 9999, 2.º 0000, 3.º 0000, 4.º 0005, 5.º 0001, 6.º 0007, 7.º 0003, 8.º 0006, 9.º 0002, 10.º 0004, ' +
				'11.º 1000, 12.º 1001, 13.º 1002, 14.º 1003, 15.º 1004, 16.º 1005, 17.º 1006, 18.º 1007, 19.º 1008, 20.º 1009'
		);

		const data = response.json() as Board;
		expect(data.quinielaDraw).toMatchObject({ source: 'Quiniela de la Ciudad, Nocturna', drawnAt: '2026-11-30T00:00:00.000Z', extracts: draw().extracts });
		const moto = prizeOf(data, 'vehicle');
		expect(moto.mechanism).toBe('quiniela');
		expect(moto.slots[0]!.state).toBe('verifying');
		expect(moto.slots[0]!.awards.map((award) => [award.role, award.rank, award.entryNumber, award.notes])).toEqual([
			['winner', 1, 0, 'Extracto 2.º de la Quiniela'],
			['alternate', 1, 3, 'Extracto 7.º de la Quiniela'],
			['alternate', 2, 6, 'Extracto 8.º de la Quiniela']
		]);
	});

	it('refuses a second draw for the same round and leaves everything as it was', async () => {
		const before = await footprint();
		const awards = await awardRows();
		const again = await confirm(draw({ extracts: twenty(2, 3, 4) }));
		expect(again.statusCode).toBe(409);
		expect(again.json().error).toMatchObject({ code: 'draw_exists', message: 'El sorteo de la Quiniela de esta ronda ya está registrado' });
		expect((await preview()).json().error.code).toBe('draw_exists');
		expect(await footprint()).toEqual(before);
		expect(await awardRows()).toEqual(awards);
	});

	it('keeps the existing decision flow: a declined winner passes the prize to the next alternate', async () => {
		const winner = prizeOf(await board(), 'vehicle').slots[0]!.awards[0]!;
		const declined = await call('POST', `/admin/awards/${winner.id}/decision`, await asOperator(), { decision: 'declined', notes: 'No respondió en el plazo de las bases' });
		expect(declined.statusCode, declined.body).toBe(200);
		const active = prizeOf(declined.json(), 'vehicle').slots[0]!.awards.find((award) => award.active)!;
		expect([active.role, active.rank, active.entryNumber]).toEqual(['alternate', 1, 3]);
	});
});

describe('transparency (ADR 0014 §3, S4)', () => {
	const url = () => `/public/campaigns/${tenant.campaignSlug}/transparency`;

	it('publishes the draw right away and which extract gave each winner once results are published', async () => {
		const early = (await ctx.app.inject({ method: 'GET', url: url(), headers: headers(tenant) })).json();
		expect(early.quinielaDraws).toEqual([
			{ round: 1, source: 'Quiniela de la Ciudad, Nocturna', drawnAt: '2026-11-30T00:00:00.000Z', extracts: draw().extracts, evidenceUrl: 'https://loteria.example/extracto-29-11.pdf', recordedAt: expect.any(String) }
		]);
		expect(early.timeline.map((event: { kind: string }) => event.kind)).toContain('quiniela_draw');
		expect(early.awards).toEqual([]);
		expect(early.vacantSlots).toEqual([]);

		expect((await call('POST', `/admin/campaigns/${tenant.campaignId}/draw-events`, await asOperator(), { kind: 'result_published', title: 'Resultados publicados', occurredAt: ctx.clock.now.toISOString() })).statusCode).toBe(200);
		const published = (await ctx.app.inject({ method: 'GET', url: url(), headers: headers(tenant) })).json() as { awards: { prize: string; slot: number; role: string; entryNumber: number; extractPosition: number | null }[]; vacantSlots: unknown[] };
		const moto = published.awards.filter((award) => award.prize === 'Moto').map((award) => [award.role, award.entryNumber, award.extractPosition]);
		// The declined winner is still the winner of record; the accepted alternate appears once accepted.
		expect(moto).toEqual([['winner', 0, 2]]);
		expect(published.awards.filter((award) => award.prize === '$100.000').map((award) => [award.slot, award.entryNumber, award.extractPosition])).toEqual([
			[1, 1, 5],
			[2, 7, 6]
		]);
		// A manual prize has no extract.
		expect(published.awards.find((award) => award.prize === 'Kit')).toMatchObject({ entryNumber: 5, extractPosition: null });
		expect(published.vacantSlots).toEqual([]);
	});

	it('shows quiniela slots nobody matched as vacant', async () => {
		const other = await createTenant(ctx, 'quiniela-vacante');
		ctx.clock.now = new Date('2026-10-25T15:00:00Z');
		await setMechanism(other, 'vehicle', { mechanism: 'quiniela' });
		await setMechanism(other, 'cash', { mechanism: 'quiniela', quantity: 3 });
		await openCampaign(ctx, other);
		await buy(other, 1);
		await toAwarding(other);

		const auth = await adminHeaders(ctx, other, other.operatorId);
		const body = draw({ extracts: twenty(1, 0) });
		const previewed = (await ctx.app.inject({ method: 'POST', url: `/admin/campaigns/${other.campaignId}/quiniela/preview`, headers: auth, payload: body })).json();
		expect(previewed.vacant.map((slot: { prizeTitle: string; slot: number }) => [slot.prizeTitle, slot.slot])).toEqual([
			['$100.000', 2],
			['$100.000', 3]
		]);
		const confirmed = await ctx.app.inject({ method: 'POST', url: `/admin/campaigns/${other.campaignId}/quiniela`, headers: auth, payload: { ...body, digest: previewed.digest } });
		expect(confirmed.statusCode, confirmed.body).toBe(200);
		expect(await awardRows(other.id)).toEqual(['cash#1 winner 0', 'vehicle#1 winner 1']);
		const cash = (confirmed.json() as Board).prizes.find((prize) => prize.kind === 'cash')!;
		expect(cash.slots.map((slot) => slot.state)).toEqual(['verifying', 'vacant', 'vacant']);

		await ctx.app.inject({ method: 'POST', url: `/admin/campaigns/${other.campaignId}/draw-events`, headers: auth, payload: { kind: 'result_published', title: 'Resultados publicados', occurredAt: ctx.clock.now.toISOString() } });
		const published = (await ctx.app.inject({ method: 'GET', url: `/public/campaigns/${other.campaignSlug}/transparency`, headers: headers(other) })).json();
		expect(published.vacantSlots).toEqual([
			{ prize: '$100.000', slot: 2 },
			{ prize: '$100.000', slot: 3 }
		]);
	});
});

/** A fresh tenant in awarding, with the given prize setup, `orders` paid orders (2 coupons each) and its operator's headers. */
async function awardingTenant(label: string, setup: (target: TenantFixture) => Promise<void>, orders = 1) {
	const target = await createTenant(ctx, label);
	ctx.clock.now = new Date('2026-10-25T15:00:00Z');
	await setup(target);
	await openCampaign(ctx, target);
	await buy(target, orders);
	await toAwarding(target);
	const auth = await adminHeaders(ctx, target, target.operatorId);
	const post = (path: string, payload: unknown) => ctx.app.inject({ method: 'POST', url: `/admin/campaigns/${target.campaignId}${path}`, headers: auth, payload: payload as Record<string, unknown> });
	return { target, auth, post };
}

interface Preview {
	slots: { prizeId: string; slot: number; winner: { entryNumber: number } | null }[];
	digest: string;
}

describe('preview and confirmation stay the same (ADR 0014 §4)', () => {
	it('refuses a confirmation whose preview no longer holds, then records the draw once under concurrent confirms', async () => {
		const { target, auth, post } = await awardingTenant('quiniela-carrera', async (target) => {
			await setMechanism(target, 'vehicle', { mechanism: 'quiniela' });
		});
		const body = draw({ extracts: twenty(0, 1) });
		const first = (await post('/quiniela/preview', body)).json() as Preview;
		expect(first.slots[0]!.winner).toEqual({ entryNumber: 0, extract: 1 });

		// Between preview and confirmation, coupon 0000 wins a kit by hand.
		expect((await post('/draw-events', { kind: 'mechanism_recorded', title: 'Kits: acta notarial', occurredAt: ctx.clock.now.toISOString() })).statusCode).toBe(200);
		const board = (await ctx.app.inject({ method: 'GET', url: `/admin/campaigns/${target.campaignId}/awards`, headers: auth })).json() as Board;
		const kitId = board.prizes.find((prize) => prize.kind === 'product')!.id;
		const kit = await ctx.app.inject({ method: 'PUT', url: `/admin/campaigns/${target.campaignId}/awards/${kitId}/slots/1`, headers: auth, payload: { winner: 0, alternates: [] } });
		expect(kit.statusCode, kit.body).toBe(200);

		const before = await footprint(target.id);
		const stale = await post('/quiniela', { ...body, digest: first.digest });
		expect(stale.statusCode).toBe(409);
		expect(stale.json().error).toMatchObject({ code: 'preview_outdated', message: 'Las coincidencias cambiaron desde la vista previa: volvé a verlas antes de confirmar' });
		expect(await footprint(target.id)).toEqual(before);

		const second = (await post('/quiniela/preview', body)).json() as Preview;
		expect(second.slots[0]!.winner).toEqual({ entryNumber: 1, extract: 2 });
		expect(second.digest).not.toBe(first.digest);

		const results = await Promise.all([post('/quiniela', { ...body, digest: second.digest }), post('/quiniela', { ...body, digest: second.digest })]);
		expect(results.map((response) => response.statusCode).sort()).toEqual([200, 409]);
		expect(results.find((response) => response.statusCode === 409)!.json().error.code).toBe('draw_exists');
		const after = await footprint(target.id);
		expect(after).toMatchObject({ draws: 1, awards: before.awards + 1, events: before.events + 1 });
		expect(await awardRows(target.id)).toEqual(['product#1 winner 0', 'vehicle#1 winner 1']);
	});
});

describe('prize order and published results (ADR 0014 §3-§4)', () => {
	it('orders prizes sharing a position by creation, then id, and refuses the draw once results are published', async () => {
		const { target, post } = await awardingTenant('quiniela-orden', async (target) => {
			await setMechanism(target, 'vehicle', { mechanism: 'quiniela', alternatesCount: 0 });
			await setMechanism(target, 'cash', { mechanism: 'quiniela', quantity: 1, alternatesCount: 0, position: 1 });
		});
		const prizes = await ctx.db.withTenant(target.id, (tx) => tx.select().from(s.prizes).where(and(eq(s.prizes.campaignId, target.campaignId), eq(s.prizes.position, 1))));
		expect(prizes).toHaveLength(2);
		// Inserted together: same creation time, so the id decides.
		expect(prizes[0]!.createdAt).toEqual(prizes[1]!.createdAt);
		const [low, high] = prizes.map((prize) => prize.id).sort();
		const body = draw({ extracts: twenty(0, 1) });
		const order = async () => ((await post('/quiniela/preview', body)).json() as Preview).slots.map((slot) => [slot.prizeId, slot.winner?.entryNumber]);
		expect(await order()).toEqual([
			[low, 0],
			[high, 1]
		]);
		// An older prize goes first whatever its id.
		await ctx.db.withTenant(target.id, (tx) => tx.update(s.prizes).set({ createdAt: new Date('2026-01-01T00:00:00Z') }).where(eq(s.prizes.id, high!)));
		expect(await order()).toEqual([
			[high, 0],
			[low, 1]
		]);

		const { digest } = (await post('/quiniela/preview', body)).json() as Preview;
		expect((await post('/draw-events', { kind: 'result_published', title: 'Resultados publicados', occurredAt: ctx.clock.now.toISOString() })).statusCode).toBe(200);
		const before = await footprint(target.id);
		const message = 'Los resultados ya se publicaron: el sorteo de la Quiniela ya no se puede registrar';
		expect((await post('/quiniela/preview', body)).json().error).toMatchObject({ code: 'results_published', message });
		const refused = await post('/quiniela', { ...body, digest });
		expect(refused.statusCode).toBe(409);
		expect(refused.json().error).toMatchObject({ code: 'results_published', message });
		expect(await footprint(target.id)).toEqual(before);
	});
});
