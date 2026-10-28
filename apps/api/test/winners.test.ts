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
 * The public winners table (S5): coupon per prize unit once its round's results
 * are published, and the winner's name, city and chances only with the consent
 * given with the purchase that holds the winning coupon.
 */
let ctx: TestContext;
let tenant: TenantFixture;
let other: TenantFixture;

interface Unit {
	slot: number;
	round: number;
	role: 'winner' | 'alternate';
	entryNumber: number;
	delivered: boolean;
	identity: { name: string; city: string | null; chances: number } | null;
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

async function paidOrder(overrides: Record<string, unknown>) {
	ctx.clock.now = new Date(ctx.clock.now.getTime() + 60_000);
	const order = await placeOrder(ctx, tenant, overrides);
	const payment = ctx.simulator.pay(order.preferenceId, 'approved');
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

const orders = {} as Record<'consenting' | 'reserved' | 'consentingAgain' | 'withdrawn', { reference: string }>;

beforeAll(async () => {
	ctx = await createTestContext();
	tenant = await createTenant(ctx, 'winners');
	other = await createTenant(ctx, 'winners-other');
	await openCampaign(ctx, tenant);
});
afterAll(() => ctx.close());

describe('checkout records the winner publicity decision with the purchase (S5)', () => {
	it('stores a granted consent on the order when the buyer checks it', async () => {
		orders.consenting = await paidOrder({
			buyer: buyer('31.000.001', 'Ana', 'Zapala'),
			consents: { terms: true, privacy: true, marketingEmail: false, winnerPublicity: true }
		});
		expect(await consentsOf(orders.consenting.reference)).toContainEqual({ purpose: 'winner_publicity', granted: true, policyVersion: 'p1', source: 'checkout' });
	});

	it('stores a refusal when the box is left unchecked or not sent', async () => {
		orders.reserved = await paidOrder({ buyer: buyer('31.000.002', 'Berta', 'Chos Malal') });
		expect(await consentsOf(orders.reserved.reference)).toContainEqual({ purpose: 'winner_publicity', granted: false, policyVersion: 'p1', source: 'checkout' });
	});

	it('records no decision for a purchase that gives no chances', async () => {
		const sticker = await placeOrder(ctx, tenant, {
			lines: [{ variantId: tenant.stickerVariantId, quantity: 1 }],
			buyer: buyer('31.000.009', 'Carla', 'Plottier'),
			delivery: { method: 'pickup' },
			consents: { terms: true, privacy: true, marketingEmail: false, winnerPublicity: true }
		});
		expect((await consentsOf(sticker.reference)).map((consent) => consent.purpose)).not.toContain('winner_publicity');
	});

	it('keeps the terms, privacy and marketing consents exactly as before', async () => {
		const order = await paidOrder({ buyer: buyer('31.000.003', 'Dora', 'Cutral Có'), consents: { terms: true, privacy: true, marketingEmail: true } });
		const consents = (await consentsOf(order.reference)).filter((consent) => consent.purpose !== 'winner_publicity');
		expect(consents.sort((a, b) => a.purpose.localeCompare(b.purpose))).toEqual([
			{ purpose: 'marketing_email', granted: true, policyVersion: 'p1', source: 'checkout' },
			{ purpose: 'privacy', granted: true, policyVersion: 'p1', source: 'checkout' },
			{ purpose: 'terms', granted: true, policyVersion: 't1', source: 'checkout' }
		]);
		const refused = await ctx.app.inject({
			method: 'POST',
			url: '/checkout/orders',
			headers: headers(tenant),
			payload: checkoutBody(tenant, { buyer: buyer('31.000.004', 'Eva', 'Junín de los Andes'), consents: { terms: false, privacy: true, marketingEmail: false } })
		});
		expect(refused.statusCode).toBe(400);
	});
});

describe('public winners table (S5)', () => {
	it('is not part of the campaign page before the results are published', async () => {
		// A second purchase by Ana, still consenting: her chances add up.
		orders.consentingAgain = await paidOrder({
			buyer: buyer('31.000.001', 'Ana', 'Zapala'),
			lines: [{ variantId: tenant.manualVariantId, quantity: 1 }],
			consents: { terms: true, privacy: true, marketingEmail: false, winnerPublicity: true }
		});
		// Fede consents, then withdraws on a later purchase.
		orders.withdrawn = await paidOrder({ buyer: buyer('31.000.005', 'Fede', 'Aluminé'), consents: { terms: true, privacy: true, marketingEmail: false, winnerPublicity: true } });
		await paidOrder({ buyer: buyer('31.000.005', 'Fede', 'Aluminé'), lines: [{ variantId: tenant.manualVariantId, quantity: 1 }] });

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
		const [anaCoupon] = await entriesOf(orders.consenting.reference);
		const [bertaCoupon, bertaAlternate] = await entriesOf(orders.reserved.reference);
		const [fedeCoupon] = await entriesOf(orders.withdrawn.reference);
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

	it('shows the coupon of every awarded unit, and the identity only with consent', async () => {
		const { body, winners } = await campaignPage();
		expect(winners).not.toBeNull();
		const [anaCoupon] = await entriesOf(orders.consenting.reference);
		const [bertaCoupon] = await entriesOf(orders.reserved.reference);
		const [fedeCoupon] = await entriesOf(orders.withdrawn.reference);

		expect(winners!.map((prize) => [prize.title, prize.quantity, prize.delivered, prize.units.length])).toEqual([
			['Moto', 1, 0, 1],
			['$100.000', 10, 0, 2],
			['Kit', 5, 0, 0]
		]);
		// Consent given with the winning purchase: full name, city and every chance bought in the campaign (2 + 1).
		expect(winners![0]!.units).toEqual([{ slot: 1, round: 1, role: 'winner', entryNumber: anaCoupon, delivered: false, identity: { name: 'Ana Ganadora', city: 'Zapala', chances: 3 } }]);
		// No consent, and a consent withdrawn by a later purchase: the coupon only.
		expect(winners![1]!.units).toEqual([
			{ slot: 1, round: 1, role: 'winner', entryNumber: bertaCoupon, delivered: false, identity: null },
			{ slot: 2, round: 1, role: 'winner', entryNumber: fedeCoupon, delivered: false, identity: null }
		]);
		expect(body).not.toMatch(/Berta|Chos Malal|Fede|Aluminé/);
		// Never document, email, phone or address, consent or not.
		expect(body).not.toMatch(/31\.?000\.?00|@example\.com|5555|Neuquén/);
	});

	it('follows the same rule for an alternate that takes the unit, and counts deliveries', async () => {
		const operator = await adminHeaders(ctx, tenant, tenant.operatorId);
		const awards = await ctx.db.withTenant(tenant.id, (tx) =>
			tx
				.select({ id: s.prizeAwards.id, role: s.prizeAwards.role, entryNumber: s.participationEntries.entryNumber })
				.from(s.prizeAwards)
				.innerJoin(s.participationEntries, eq(s.participationEntries.id, s.prizeAwards.entryId))
				.where(and(eq(s.prizeAwards.campaignId, tenant.campaignId), inArray(s.prizeAwards.role, ['winner', 'alternate'])))
		);
		const [anaCoupon] = await entriesOf(orders.consenting.reference);
		const [bertaCoupon, bertaAlternate] = await entriesOf(orders.reserved.reference);
		const idOf = (entryNumber: number) => awards.find((award) => award.entryNumber === entryNumber)!.id;
		const decide = (id: string, decision: string) => ctx.app.inject({ method: 'POST', url: `/admin/awards/${id}/decision`, headers: operator, payload: { decision, notes: 'Sin respuesta' } });
		expect((await decide(idOf(bertaCoupon!), 'declined')).statusCode).toBe(200);
		expect((await decide(idOf(anaCoupon!), 'accepted')).statusCode).toBe(200);
		const delivered = await ctx.app.inject({ method: 'PUT', url: `/admin/awards/${idOf(anaCoupon!)}/fulfillment`, headers: operator, payload: { status: 'delivered' } });
		expect(delivered.statusCode, delivered.body).toBe(200);

		const { winners } = await campaignPage();
		expect(winners![0]).toMatchObject({ delivered: 1, units: [{ entryNumber: anaCoupon, delivered: true, identity: { name: 'Ana Ganadora' } }] });
		expect(winners![1]!.units[0]).toEqual({ slot: 1, round: 1, role: 'alternate', entryNumber: bertaAlternate, delivered: false, identity: null });
	});
});

interface OrderPublicity {
	winnerPublicity: { publishable: boolean; withdrawable: boolean; withdrawnAt: string | null } | null;
}

const withdraw = (orderId: string, auth: Record<string, string>) => ctx.app.inject({ method: 'POST', url: `/admin/orders/${orderId}/winner-publicity/withdraw`, headers: auth });

async function publicityRows(contactId: string) {
	return ctx.db.withTenant(tenant.id, (tx) =>
		tx
			.select({ orderId: s.contactConsents.orderId, granted: s.contactConsents.granted, policyVersion: s.contactConsents.policyVersion, source: s.contactConsents.source })
			.from(s.contactConsents)
			.where(and(eq(s.contactConsents.contactId, contactId), eq(s.contactConsents.purpose, 'winner_publicity')))
	);
}

describe('withdrawing the winner publicity consent on request (S5, S9)', () => {
	it('is only for admins who see personal data, and only for orders of their organization', async () => {
		const order = await orderByReference(ctx, tenant, orders.consentingAgain.reference);
		const operator = await adminHeaders(ctx, tenant, tenant.operatorId);
		expect((await withdraw(order.id, operator)).statusCode).toBe(403);
		expect((await withdraw(order.id, await adminHeaders(ctx, other))).statusCode).toBe(404);
		expect((await ctx.app.inject({ method: 'POST', url: `/admin/orders/${order.id}/winner-publicity/withdraw`, headers: headers(tenant) })).statusCode).toBe(401);
		// Nothing was recorded by the refused calls: Ana's consent is still published.
		expect((await publicityRows(order.contactId)).every((row) => row.orderId !== null)).toBe(true);
		expect((await campaignPage()).winners![0]!.units[0]!.identity).toMatchObject({ name: 'Ana Ganadora' });
	});

	it('shows on the order whether the identity can be published now', async () => {
		const order = await orderByReference(ctx, tenant, orders.consenting.reference);
		const detail = await ctx.app.inject({ method: 'GET', url: `/admin/orders/${order.id}`, headers: await adminHeaders(ctx, tenant, tenant.operatorId) });
		expect(detail.statusCode, detail.body).toBe(200);
		expect((detail.json() as OrderPublicity).winnerPublicity).toEqual({ publishable: true, withdrawable: true, withdrawnAt: null });
		const refused = await orderByReference(ctx, tenant, orders.reserved.reference);
		const refusedDetail = await ctx.app.inject({ method: 'GET', url: `/admin/orders/${refused.id}`, headers: await adminHeaders(ctx, tenant) });
		expect((refusedDetail.json() as OrderPublicity).winnerPublicity).toEqual({ publishable: false, withdrawable: false, withdrawnAt: null });
	});

	it('honours a withdrawal recorded without a purchase, as the privacy text promises', async () => {
		// Asked from her second purchase: it withdraws the consent of the winning first one too.
		const order = await orderByReference(ctx, tenant, orders.consentingAgain.reference);
		const response = await withdraw(order.id, await adminHeaders(ctx, tenant));
		expect(response.statusCode, response.body).toBe(200);
		expect(response.json()).toMatchObject({ recorded: true, winnerPublicity: { publishable: false } });
		expect(response.body).not.toMatch(/Ana|Zapala|31\.?000|@example\.com/);

		expect(await publicityRows(order.contactId)).toContainEqual({ orderId: null, granted: false, policyVersion: 'p1', source: 'support' });
		const { body, winners } = await campaignPage();
		const [anaCoupon] = await entriesOf(orders.consenting.reference);
		expect(winners![0]!.units).toEqual([{ slot: 1, round: 1, role: 'winner', entryNumber: anaCoupon, delivered: true, identity: null }]);
		expect(body).not.toMatch(/Ana|Zapala/);

		const winning = await orderByReference(ctx, tenant, orders.consenting.reference);
		const detail = await ctx.app.inject({ method: 'GET', url: `/admin/orders/${winning.id}`, headers: await adminHeaders(ctx, tenant) });
		const publicity = (detail.json() as OrderPublicity).winnerPublicity;
		expect(publicity?.publishable).toBe(false);
		expect(publicity?.withdrawnAt).toEqual(expect.any(String));
	});

	it('records the withdrawal in the audit log without personal data', async () => {
		const order = await orderByReference(ctx, tenant, orders.consentingAgain.reference);
		const rows = await ctx.db.withTenant(tenant.id, (tx) =>
			tx.select().from(s.auditEvents).where(and(eq(s.auditEvents.action, 'order.winner_publicity_withdrawn'), eq(s.auditEvents.targetId, order.id)))
		);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ actorType: 'admin', actorId: tenant.ownerId, targetType: 'order' });
		expect(JSON.stringify(rows)).not.toMatch(/Ana|Zapala|31\.?000|@example\.com|5555/);
	});

	it('changes nothing when asked again', async () => {
		const order = await orderByReference(ctx, tenant, orders.consenting.reference);
		const before = await publicityRows(order.contactId);
		const again = await withdraw(order.id, await adminHeaders(ctx, tenant));
		expect(again.statusCode, again.body).toBe(200);
		expect(again.json()).toMatchObject({ recorded: false, winnerPublicity: { publishable: false, withdrawable: false } });
		expect(await publicityRows(order.contactId)).toEqual(before);
		const audited = await ctx.db.withTenant(tenant.id, (tx) => tx.select().from(s.auditEvents).where(eq(s.auditEvents.action, 'order.winner_publicity_withdrawn')));
		expect(audited).toHaveLength(1);
	});

	it('still lets checkout record the decision with each later purchase, which covers that purchase only', async () => {
		// This organization's campaign is closed; the other one sells while Gabi consents, withdraws and consents again.
		ctx.clock.now = new Date('2026-10-26T12:00:00Z');
		await openCampaign(ctx, other);
		const owner = await adminHeaders(ctx, other);
		const consenting = { terms: true, privacy: true, marketingEmail: false, winnerPublicity: true };
		const first = await placeOrder(ctx, other, { buyer: buyer('31.000.007', 'Gabi', 'Villa La Angostura'), consents: consenting });
		const firstOrder = await orderByReference(ctx, other, first.reference);
		expect((await withdraw(firstOrder.id, owner)).json()).toMatchObject({ recorded: true });
		const later = await placeOrder(ctx, other, { buyer: buyer('31.000.007', 'Gabi', 'Villa La Angostura'), consents: consenting });
		const laterOrder = await orderByReference(ctx, other, later.reference);

		const stored = await ctx.db.withTenant(other.id, (tx) =>
			tx
				.select({ purpose: s.contactConsents.purpose, granted: s.contactConsents.granted, policyVersion: s.contactConsents.policyVersion, source: s.contactConsents.source })
				.from(s.contactConsents)
				.where(eq(s.contactConsents.orderId, laterOrder.id))
		);
		expect(stored.sort((a, b) => a.purpose.localeCompare(b.purpose))).toEqual([
			{ purpose: 'marketing_email', granted: false, policyVersion: 'p1', source: 'checkout' },
			{ purpose: 'privacy', granted: true, policyVersion: 'p1', source: 'checkout' },
			{ purpose: 'terms', granted: true, policyVersion: 't1', source: 'checkout' },
			{ purpose: 'winner_publicity', granted: true, policyVersion: 'p1', source: 'checkout' }
		]);
		const publicityOf = async (orderId: string) => ((await ctx.app.inject({ method: 'GET', url: `/admin/orders/${orderId}`, headers: owner })).json() as OrderPublicity).winnerPublicity;
		expect(await publicityOf(laterOrder.id)).toEqual({ publishable: true, withdrawable: true, withdrawnAt: null });
		expect((await publicityOf(firstOrder.id))?.publishable).toBe(false);
		// The new consent is a new decision: asking again records a new withdrawal.
		expect((await withdraw(laterOrder.id, owner)).json()).toMatchObject({ recorded: true, winnerPublicity: { publishable: false } });
	});
});
