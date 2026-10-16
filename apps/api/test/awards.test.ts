import { randomUUID } from 'node:crypto';
import { eq, schema as s } from '@sortea/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminHeaders, createTenant, createTestContext, headers, openCampaign, placeOrder, webhookRequest, type TenantFixture, type TestContext } from './helpers';

let ctx: TestContext;
let tenant: TenantFixture;
const financeId = randomUUID();
let entryNumbers: number[] = [];

interface Award {
	id: string;
	role: 'winner' | 'alternate';
	rank: number;
	status: string;
	entryNumber: number;
	active: boolean;
	holder: { name: string; email: string; location: string | null } | null;
	fulfillment: { status: string; deliveredAt: string | null; evidenceUrl: string | null } | null;
}
interface Board {
	mechanismRecorded: boolean;
	resultsPublished: boolean;
	canOperate: boolean;
	prizes: { id: string; kind: string; quantity: number; alternatesCount: number; slots: { slot: number; state: string; canRecord: boolean; awards: Award[] }[] }[];
}

const asOwner = () => adminHeaders(ctx, tenant);
const asOperator = () => adminHeaders(ctx, tenant, tenant.operatorId);

async function call(method: 'GET' | 'PUT' | 'POST', url: string, auth: Record<string, string>, payload?: unknown) {
	return ctx.app.inject({ method, url, headers: auth, payload: payload as Record<string, unknown> | undefined });
}

async function board(auth?: Record<string, string>): Promise<Board> {
	const response = await call('GET', `/admin/campaigns/${tenant.campaignId}/awards`, auth ?? (await asOperator()));
	expect(response.statusCode, response.body).toBe(200);
	return response.json();
}

async function record(prizeId: string, slot: number, winner: number, alternates: number[] = []) {
	return call('PUT', `/admin/campaigns/${tenant.campaignId}/awards/${prizeId}/slots/${slot}`, await asOperator(), { winner, alternates });
}

async function decide(awardId: string, decision: 'accepted' | 'declined' | 'void', notes?: string) {
	return call('POST', `/admin/awards/${awardId}/decision`, await asOperator(), { decision, notes });
}

async function fulfill(awardId: string, payload: Record<string, unknown>) {
	return call('PUT', `/admin/awards/${awardId}/fulfillment`, await asOperator(), payload);
}

async function drawEvent(kind: string, title: string) {
	const response = await call('POST', `/admin/campaigns/${tenant.campaignId}/draw-events`, await asOperator(), { kind, title, occurredAt: ctx.clock.now.toISOString() });
	expect(response.statusCode, response.body).toBe(200);
}

async function transition(to: string) {
	return call('POST', `/admin/campaigns/${tenant.campaignId}/transition`, await asOwner(), { to });
}

const slotOf = (data: Board, kind: string, slot: number) => data.prizes.find((prize) => prize.kind === kind)!.slots.find((candidate) => candidate.slot === slot)!;
const prizeId = (data: Board, kind: string) => data.prizes.find((prize) => prize.kind === kind)!.id;

beforeAll(async () => {
	ctx = await createTestContext();
	tenant = await createTenant(ctx, 'awards');
	await ctx.db.withPlatform((db) => db.insert(s.organizationMembers).values({ organizationId: tenant.id, userId: financeId, email: `finance@${tenant.host}`, role: 'finance_manager' }));
	await openCampaign(ctx, tenant);

	// 18 paid orders of two manuals: 36 participations, enough for every winner and alternate.
	for (let index = 0; index < 18; index++) {
		ctx.clock.now = new Date(ctx.clock.now.getTime() + 60_000);
		const order = await placeOrder(ctx, tenant, {
			buyer: { documentType: 'DNI', documentNumber: String(30_000_000 + index), firstName: `Persona${index}`, lastName: 'Prueba', email: `persona${index}@example.com`, province: 'Tierra del Fuego', city: 'Ushuaia' }
		});
		const payment = ctx.simulator.pay(order.preferenceId, 'approved');
		expect((await ctx.app.inject(webhookRequest(tenant, payment.id))).statusCode).toBe(200);
	}
	const entries = await ctx.db.withTenant(tenant.id, (tx) => tx.select({ number: s.participationEntries.entryNumber }).from(s.participationEntries).where(eq(s.participationEntries.campaignId, tenant.campaignId)));
	entryNumbers = entries.map((entry) => entry.number).sort((a, b) => a - b);
	expect(entryNumbers).toHaveLength(36);
});
afterAll(() => ctx.close());

describe('recording results (DRAW-INTEGRITY 5)', () => {
	it('only records results once the campaign is in awarding and the mechanism is on the public log', async () => {
		const early = await board();
		expect((await record(prizeId(early, 'vehicle'), 1, entryNumbers[0]!)).json().error.code).toBe('not_awarding');

		ctx.clock.now = new Date('2026-11-29T01:00:00Z');
		const closed = await call('POST', `/admin/campaigns/${tenant.campaignId}/close`, await asOwner());
		expect(closed.statusCode, closed.body).toBe(200);
		expect((await transition('awarding')).statusCode).toBe(200);

		const noMechanism = await record(prizeId(early, 'vehicle'), 1, entryNumbers[0]!);
		expect(noMechanism.json().error.code).toBe('mechanism_required');
		await drawEvent('mechanism_recorded', 'Lotería de la Provincia, sorteo del 29/11, primeros premios');
		expect((await board()).mechanismRecorded).toBe(true);
	});

	it('lets operators record results but not finance (PRD §4)', async () => {
		const data = await board();
		const finance = await call('PUT', `/admin/campaigns/${tenant.campaignId}/awards/${prizeId(data, 'vehicle')}/slots/1`, await adminHeaders(ctx, tenant, financeId), {
			winner: entryNumbers[0]
		});
		expect(finance.statusCode).toBe(403);
	});

	it('checks every number against the published manifest', async () => {
		const vehicle = prizeId(await board(), 'vehicle');
		expect((await record(vehicle, 1, 999_999)).json().error.code).toBe('not_in_manifest');
		expect((await record(vehicle, 1, entryNumbers[0]!, [entryNumbers[0]!])).json().error.code).toBe('duplicate_entry');
		expect((await record(vehicle, 1, entryNumbers[0]!, [entryNumbers[1]!, entryNumbers[2]!, entryNumbers[3]!])).json().error.code).toBe('too_many_alternates');
		expect((await record(vehicle, 2, entryNumbers[0]!)).json().error.code).toBe('invalid_slot');
	});

	it('records 16 independent prize units with their alternates (AC-06)', async () => {
		let data = await board();
		let next = 0;
		const take = (count: number) => entryNumbers.slice(next, (next += count));
		for (const prize of data.prizes) {
			for (let slot = 1; slot <= prize.quantity; slot++) {
				const [winner, ...alternates] = take(1 + prize.alternatesCount);
				const response = await record(prize.id, slot, winner!, alternates);
				expect(response.statusCode, response.body).toBe(200);
			}
		}
		data = await board();
		const slots = data.prizes.flatMap((prize) => prize.slots);
		expect(slots).toHaveLength(16);
		expect(slots.every((slot) => slot.state === 'verifying')).toBe(true);
		expect(slotOf(data, 'vehicle', 1).awards.map((award) => [award.role, award.rank])).toEqual([
			['winner', 1],
			['alternate', 1],
			['alternate', 2]
		]);
		// An entry already awarded cannot be used again in another unit.
		const reused = await record(prizeId(data, 'cash'), 1, slotOf(data, 'vehicle', 1).awards[0]!.entryNumber);
		expect(reused.json().error.code).toBe('already_awarded');
	});

	it('allows fixing a typo only before any decision', async () => {
		const data = await board();
		const unused = entryNumbers.at(-1)!;
		const cashSlot = slotOf(data, 'cash', 10);
		const fixed = await record(prizeId(data, 'cash'), 10, unused, [cashSlot.awards[1]!.entryNumber]);
		expect(fixed.statusCode, fixed.body).toBe(200);
		expect(slotOf(fixed.json(), 'cash', 10).awards[0]!.entryNumber).toBe(unused);
		const audits = await ctx.db.withTenant(tenant.id, (tx) => tx.select().from(s.auditEvents).where(eq(s.auditEvents.action, 'award.slot_corrected')));
		expect(audits).toHaveLength(1);
	});
});

describe('verification, alternates and delivery (AC-06)', () => {
	it('moves to the next alternate only after the holder declines, with a reason', async () => {
		let vehicle = slotOf(await board(), 'vehicle', 1);
		const [winner, first] = vehicle.awards;
		expect((await decide(first!.id, 'accepted')).json().error.code).toBe('not_active');
		expect((await decide(winner!.id, 'declined')).statusCode).toBe(400);

		const declined = await decide(winner!.id, 'declined', 'No respondió en el plazo de las bases');
		expect(declined.statusCode, declined.body).toBe(200);
		vehicle = slotOf(declined.json(), 'vehicle', 1);
		expect(vehicle.awards.find((award) => award.active)!.id).toBe(first!.id);
		expect((await decide(winner!.id, 'accepted')).json().error.code).toBe('already_decided');

		const locked = await record(prizeId(declined.json(), 'vehicle'), 1, entryNumbers[0]!, [entryNumbers[1]!]);
		expect(locked.json().error.code).toBe('slot_locked');

		const accepted = await decide(first!.id, 'accepted');
		vehicle = slotOf(accepted.json(), 'vehicle', 1);
		expect(vehicle.state).toBe('accepted');
		expect(vehicle.awards.find((award) => award.id === first!.id)!.fulfillment).toMatchObject({ status: 'pending' });
	});

	it('tracks each delivery independently and freezes it once delivered', async () => {
		const data = await board();
		const vehicle = slotOf(data, 'vehicle', 1).awards.find((award) => award.active)!;
		expect((await fulfill(vehicle.id, { status: 'scheduled' })).json().error.code).toBe('schedule_required');
		expect((await fulfill(vehicle.id, { status: 'scheduled', scheduledFor: '2026-12-05T15:00:00Z' })).statusCode).toBe(200);
		expect((await fulfill(vehicle.id, { status: 'failed', notes: 'No se presentó' })).statusCode).toBe(200);
		expect((await fulfill(vehicle.id, { status: 'scheduled', scheduledFor: '2026-12-12T15:00:00Z' })).statusCode).toBe(200);
		const delivered = await fulfill(vehicle.id, { status: 'delivered', evidenceUrl: 'https://example.com/entrega-moto.jpg' });
		expect(delivered.statusCode, delivered.body).toBe(200);
		expect(slotOf(delivered.json(), 'vehicle', 1).state).toBe('delivered');
		expect((await fulfill(vehicle.id, { status: 'scheduled', scheduledFor: '2026-12-20T15:00:00Z' })).json().error.code).toBe('invalid_fulfillment');

		// Other units are untouched.
		const after = await board();
		expect(slotOf(after, 'cash', 1).state).toBe('verifying');
		expect(slotOf(after, 'product', 1).state).toBe('verifying');

		const notAccepted = slotOf(after, 'cash', 1).awards[0]!;
		expect((await fulfill(notAccepted.id, { status: 'delivered' })).json().error.code).toBe('not_accepted');
	});

	it('shows contact data only to roles with that permission, and audits it', async () => {
		const operatorView = slotOf(await board(), 'cash', 1).awards[0]!.holder!;
		expect(operatorView.email).toMatch(/^\w{2}\*+@example\.com$/);
		expect(operatorView.name).toMatch(/^Persona\d+ P\.$/);
		expect(operatorView.location).toBe('Tierra del Fuego');
		const ownerView = slotOf(await board(await asOwner()), 'cash', 1).awards[0]!.holder!;
		expect(ownerView.email).toMatch(/^persona\d+@example\.com$/);
		expect(ownerView.name).toMatch(/^Persona\d+ Prueba$/);
		expect(ownerView.location).toBe('Ushuaia, Tierra del Fuego');
		const audits = await ctx.db.withTenant(tenant.id, (tx) => tx.select().from(s.auditEvents).where(eq(s.auditEvents.action, 'awards.pii_viewed')));
		expect(audits.length).toBeGreaterThanOrEqual(1);
	});
});

describe('publication and completion', () => {
	it('keeps results off the public page until they are published, then shows no personal data', async () => {
		const url = `/public/campaigns/${tenant.campaignSlug}/transparency`;
		expect((await ctx.app.inject({ method: 'GET', url, headers: headers(tenant) })).json().awards).toEqual([]);

		await drawEvent('result_published', 'Resultados publicados');
		const published = await ctx.app.inject({ method: 'GET', url, headers: headers(tenant) });
		const awards = published.json().awards as { prize: string; entryNumber: number; status: string }[];
		expect(awards.length).toBeGreaterThanOrEqual(16);
		// Delivery evidence is public on purpose; buyers' names and emails never are.
		expect(published.body).not.toMatch(/persona\d+@|Persona\d+|Ushuaia|Tierra del Fuego/i);

		// Published results are frozen.
		const data = await board();
		expect(slotOf(data, 'cash', 2).canRecord).toBe(false);
		expect((await record(prizeId(data, 'cash'), 2, entryNumbers[0]!)).json().error.code).toBe('slot_locked');
	});

	it('finishes the campaign only when every unit was delivered or ran out of alternates', async () => {
		expect((await transition('fulfilled')).json().error.code).toBe('awards_pending');

		const data = await board();
		for (const prize of data.prizes) {
			for (const slot of prize.slots) {
				if (slot.state === 'delivered') continue;
				if (prize.kind === 'product' && slot.slot === 5) {
					// Nobody in this unit claims it: the prize follows the published rules.
					for (const award of slot.awards) expect((await decide(award.id, 'declined', 'No reclamó el premio en plazo')).statusCode).toBe(200);
					continue;
				}
				const holder = slot.awards.find((award) => award.active)!;
				expect((await decide(holder.id, 'accepted')).statusCode).toBe(200);
				expect((await fulfill(holder.id, { status: 'delivered' })).statusCode).toBe(200);
			}
		}
		expect(slotOf(await board(), 'product', 5).state).toBe('exhausted');
		const finished = await transition('fulfilled');
		expect(finished.statusCode, finished.body).toBe(200);
		expect((await board()).canOperate).toBe(false);
	});
});
