import { and, eq, inArray, schema as s } from '@sortea/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	adminHeaders,
	checkoutBody,
	createTenant,
	createTestContext,
	headers,
	openCampaign,
	orderByReference,
	placeOrder,
	webhookRequest,
	type TenantFixture,
	type TestContext
} from './helpers';

/**
 * The public winners table (S5; owner-feedback-2026-11-14 S3): coupon per
 * prize unit once its round's results are published, and always the winner's
 * name, city and chances. Never document, email, phone or address. Checkout no
 * longer asks whether to publish the winner's name.
 */
let ctx: TestContext;
let tenant: TenantFixture;

interface Unit {
	slot: number;
	round: number;
	role: 'winner' | 'alternate';
	source: 'app_draw' | 'quiniela' | 'manual';
	entryNumber: number;
	delivered: boolean;
	identity: { name: string; city: string | null; chances: number };
}
interface WinnersPrize {
	position: number;
	title: string;
	quantity: number;
	delivered: number;
	units: Unit[];
}

const buyer = (document: string, firstName: string, city: string) => ({
	documentType: 'DNI',
	documentNumber: document,
	firstName,
	lastName: 'Ganadora',
	email: `${firstName.toLowerCase()}@example.com`,
	phone: '+54 9 11 5555-0000',
	province: 'Neuquén',
	city
});
// Never on the public page, for any winner.
const forbiddenData = /31\.?000\.?00|@example\.com|5555|Neuquén|documentNumber|"email"|"phone"|"address"|street/;

async function paidOrder(overrides: Record<string, unknown>) {
	ctx.clock.now = new Date(ctx.clock.now.getTime() + 60_000);
	const order = await placeOrder(ctx, tenant, overrides);
	const payment = ctx.simulator.pay(order.checkoutId, 'approved');
	expect((await ctx.app.inject(webhookRequest(tenant, payment.id))).statusCode).toBe(200);
	return order;
}

async function consentsOf(reference: string) {
	const order = await orderByReference(ctx, tenant, reference);
	return ctx.db.withTenant(tenant.id, (tx) =>
		tx
			.select({ purpose: s.contactConsents.purpose, granted: s.contactConsents.granted, policyVersion: s.contactConsents.policyVersion, source: s.contactConsents.source })
			.from(s.contactConsents)
			.where(eq(s.contactConsents.orderId, order.id))
	);
}

async function entriesOf(reference: string): Promise<number[]> {
	const order = await orderByReference(ctx, tenant, reference);
	const rows = await ctx.db.withTenant(tenant.id, (tx) =>
		tx.select({ number: s.participationEntries.entryNumber }).from(s.participationEntries).where(eq(s.participationEntries.orderId, order.id))
	);
	return rows.map((row) => row.number).sort((a, b) => a - b);
}

async function campaignPage() {
	const response = await ctx.app.inject({ method: 'GET', url: `/public/campaigns/${tenant.campaignSlug}`, headers: headers(tenant) });
	expect(response.statusCode, response.body).toBe(200);
	return { body: response.body, winners: response.json().winners as WinnersPrize[] | null };
}

/**
 * A `winner_publicity` refusal as checkout stored it before S3, on the
 * order and as a withdrawal on request. Stored data stays; nothing reads it for publicity.
 */
async function storeOldRefusals(reference: string) {
	const order = await orderByReference(ctx, tenant, reference);
	await ctx.db.withTenant(tenant.id, (tx) =>
		tx.insert(s.contactConsents).values([
			{ organizationId: tenant.id, contactId: order.contactId, purpose: 'winner_publicity', granted: false, policyVersion: 'p1', source: 'checkout', orderId: order.id },
			{ organizationId: tenant.id, contactId: order.contactId, purpose: 'winner_publicity', granted: false, policyVersion: 'p1', source: 'support', orderId: null }
		])
	);
}

const orders = {} as Record<'ana' | 'anaAgain' | 'berta' | 'fede', { reference: string }>;

beforeAll(async () => {
	ctx = await createTestContext();
	tenant = await createTenant(ctx, 'winners');
	await openCampaign(ctx, tenant);
});
afterAll(() => ctx.close());

describe('checkout records no winner publicity choice (S3)', () => {
	it('accepts a purchase without the field and records the terms, privacy, marketing and adult consents only', async () => {
		orders.ana = await paidOrder({ buyer: buyer('31.000.001', 'Ana', 'Zapala'), consents: { terms: true, privacy: true, marketingEmail: true, adultDeclaration: true } });
		const consents = await consentsOf(orders.ana.reference);
		expect(consents.sort((a, b) => a.purpose.localeCompare(b.purpose))).toEqual([
			{ purpose: 'adult_declaration', granted: true, policyVersion: 't1', source: 'checkout' },
			{ purpose: 'marketing_email', granted: true, policyVersion: 'p1', source: 'checkout' },
			{ purpose: 'privacy', granted: true, policyVersion: 'p1', source: 'checkout' },
			{ purpose: 'terms', granted: true, policyVersion: 't1', source: 'checkout' }
		]);
	});

	it('ignores the field sent by an old form, granted or not', async () => {
		orders.berta = await paidOrder({ buyer: buyer('31.000.002', 'Berta', 'Chos Malal'), consents: { terms: true, privacy: true, marketingEmail: false, winnerPublicity: false, adultDeclaration: true } });
		orders.fede = await paidOrder({ buyer: buyer('31.000.005', 'Fede', 'Aluminé'), consents: { terms: true, privacy: true, marketingEmail: false, winnerPublicity: true, adultDeclaration: true } });
		for (const order of [orders.berta, orders.fede]) expect((await consentsOf(order.reference)).map((consent) => consent.purpose)).not.toContain('winner_publicity');
	});

	it('still refuses a purchase without the terms', async () => {
		const refused = await ctx.app.inject({
			method: 'POST',
			url: '/checkout/orders',
			headers: headers(tenant),
			payload: checkoutBody(tenant, { buyer: buyer('31.000.004', 'Eva', 'Junín de los Andes'), consents: { terms: false, privacy: true, marketingEmail: false, adultDeclaration: true } })
		});
		expect(refused.statusCode).toBe(400);
	});
});

describe('public winners table (S5, S3)', () => {
	it('is not part of the campaign page before the results are published', async () => {
		// A second purchase by Ana: her chances add up.
		orders.anaAgain = await paidOrder({ buyer: buyer('31.000.001', 'Ana', 'Zapala'), lines: [{ variantId: tenant.manualVariantId, quantity: 1 }] });
		// Berta refused under the old checkout and later asked to withdraw: the stored rows no longer hide her.
		await storeOldRefusals(orders.berta.reference);

		ctx.clock.now = new Date('2026-11-29T01:00:00Z');
		const owner = await adminHeaders(ctx, tenant);
		const operator = await adminHeaders(ctx, tenant, tenant.operatorId);
		expect((await ctx.app.inject({ method: 'POST', url: `/admin/campaigns/${tenant.campaignId}/close`, headers: owner })).statusCode).toBe(200);
		expect((await ctx.app.inject({ method: 'POST', url: `/admin/campaigns/${tenant.campaignId}/transition`, headers: owner, payload: { to: 'awarding' } })).statusCode).toBe(200);
		const event = (kind: string, title: string) =>
			ctx.app.inject({ method: 'POST', url: `/admin/campaigns/${tenant.campaignId}/draw-events`, headers: operator, payload: { kind, title, occurredAt: ctx.clock.now.toISOString() } });
		expect((await event('mechanism_recorded', 'Quiniela de la Ciudad, Nocturna')).statusCode).toBe(200);

		const prizes = await ctx.db.withTenant(tenant.id, (tx) => tx.select().from(s.prizes).where(eq(s.prizes.campaignId, tenant.campaignId)));
		const prizeOf = (kind: string) => prizes.find((prize) => prize.kind === kind)!.id;
		const [anaCoupon] = await entriesOf(orders.ana.reference);
		const [bertaCoupon, bertaAlternate] = await entriesOf(orders.berta.reference);
		const [fedeCoupon] = await entriesOf(orders.fede.reference);
		const record = (prizeId: string, slot: number, winner: number, alternates: number[] = []) =>
			ctx.app.inject({ method: 'PUT', url: `/admin/campaigns/${tenant.campaignId}/awards/${prizeId}/slots/${slot}`, headers: operator, payload: { winner, alternates } });
		expect((await record(prizeOf('vehicle'), 1, anaCoupon!)).statusCode).toBe(200);
		expect((await record(prizeOf('cash'), 1, bertaCoupon!, [bertaAlternate!])).statusCode).toBe(200);
		expect((await record(prizeOf('cash'), 2, fedeCoupon!)).statusCode).toBe(200);

		const before = await campaignPage();
		expect(before.winners).toBeNull();
		expect(before.body).not.toMatch(/Ana|Berta|Fede|Zapala|Chos Malal|Aluminé/);

		expect((await event('result_published', 'Resultados publicados')).statusCode).toBe(200);
	});

	it('shows the coupon, name, city and chances of every winner, whatever the old consent rows say', async () => {
		const { body, winners } = await campaignPage();
		expect(winners).not.toBeNull();
		const [anaCoupon] = await entriesOf(orders.ana.reference);
		const [bertaCoupon] = await entriesOf(orders.berta.reference);
		const [fedeCoupon] = await entriesOf(orders.fede.reference);

		expect(winners!.map((prize) => [prize.title, prize.quantity, prize.delivered, prize.units.length])).toEqual([
			['Moto', 1, 0, 1],
			['$100.000', 10, 0, 2],
			['Kit', 5, 0, 0]
		]);
		// Full name, city and every chance bought in the campaign (2 + 1).
		expect(winners![0]!.units).toEqual([{ slot: 1, round: 1, role: 'winner', source: 'manual', entryNumber: anaCoupon, delivered: false, identity: { name: 'Ana Ganadora', city: 'Zapala', chances: 3 } }]);
		expect(winners![1]!.units).toEqual([
			{ slot: 1, round: 1, role: 'winner', source: 'manual', entryNumber: bertaCoupon, delivered: false, identity: { name: 'Berta Ganadora', city: 'Chos Malal', chances: 2 } },
			{ slot: 2, round: 1, role: 'winner', source: 'manual', entryNumber: fedeCoupon, delivered: false, identity: { name: 'Fede Ganadora', city: 'Aluminé', chances: 2 } }
		]);
		// The identity carries exactly these keys: never document, email, phone or address.
		for (const unit of winners!.flatMap((prize) => prize.units)) expect(Object.keys(unit.identity).sort()).toEqual(['chances', 'city', 'name']);
		expect(body).not.toMatch(forbiddenData);
	});

	it('names an alternate that takes the unit the same way, and counts deliveries', async () => {
		const operator = await adminHeaders(ctx, tenant, tenant.operatorId);
		const awards = await ctx.db.withTenant(tenant.id, (tx) =>
			tx
				.select({ id: s.prizeAwards.id, role: s.prizeAwards.role, entryNumber: s.participationEntries.entryNumber })
				.from(s.prizeAwards)
				.innerJoin(s.participationEntries, eq(s.participationEntries.id, s.prizeAwards.entryId))
				.where(and(eq(s.prizeAwards.campaignId, tenant.campaignId), inArray(s.prizeAwards.role, ['winner', 'alternate'])))
		);
		const [anaCoupon] = await entriesOf(orders.ana.reference);
		const [bertaCoupon, bertaAlternate] = await entriesOf(orders.berta.reference);
		const idOf = (entryNumber: number) => awards.find((award) => award.entryNumber === entryNumber)!.id;
		const decide = (id: string, decision: string) => ctx.app.inject({ method: 'POST', url: `/admin/awards/${id}/decision`, headers: operator, payload: { decision, notes: 'Sin respuesta' } });
		expect((await decide(idOf(bertaCoupon!), 'declined')).statusCode).toBe(200);
		expect((await decide(idOf(anaCoupon!), 'accepted')).statusCode).toBe(200);
		const delivered = await ctx.app.inject({ method: 'PUT', url: `/admin/awards/${idOf(anaCoupon!)}/fulfillment`, headers: operator, payload: { status: 'delivered' } });
		expect(delivered.statusCode, delivered.body).toBe(200);

		const { body, winners } = await campaignPage();
		expect(winners![0]).toMatchObject({ delivered: 1, units: [{ entryNumber: anaCoupon, delivered: true, identity: { name: 'Ana Ganadora' } }] });
		expect(winners![1]!.units[0]).toEqual({ slot: 1, round: 1, role: 'alternate', source: 'manual', entryNumber: bertaAlternate, delivered: false, identity: { name: 'Berta Ganadora', city: 'Chos Malal', chances: 2 } });
		expect(body).not.toMatch(forbiddenData);
	});
});

describe('the panel after S3', () => {
	it('no longer offers withdrawing the winner publicity consent', async () => {
		const order = await orderByReference(ctx, tenant, orders.berta.reference);
		const response = await ctx.app.inject({ method: 'POST', url: `/admin/orders/${order.id}/winner-publicity/withdraw`, headers: await adminHeaders(ctx, tenant) });
		expect(response.statusCode).toBe(404);
		const rows = await ctx.db.withTenant(tenant.id, (tx) =>
			tx.select().from(s.contactConsents).where(and(eq(s.contactConsents.contactId, order.contactId), eq(s.contactConsents.purpose, 'winner_publicity')))
		);
		expect(rows).toHaveLength(2);
	});

	it('drops the publicity summary from the order detail and still lists the stored consents, with document and address for orders.pii', async () => {
		const order = await orderByReference(ctx, tenant, orders.berta.reference);
		const detail = await ctx.app.inject({ method: 'GET', url: `/admin/orders/${order.id}`, headers: await adminHeaders(ctx, tenant) });
		expect(detail.statusCode, detail.body).toBe(200);
		const json = detail.json() as { consents: { purpose: string; granted: boolean }[] } & Record<string, unknown>;
		expect(json).not.toHaveProperty('winnerPublicity');
		expect(json.consents).toContainEqual(expect.objectContaining({ purpose: 'winner_publicity', granted: false }));
		expect(detail.body).toMatch(/31\.?000\.?002/);
	});
});
