import { randomUUID } from 'node:crypto';
import { and, eq, schema as s } from '@sortea/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminHeaders, createTenant, createTestContext, headers, openCampaign, orderByReference, placeOrder, webhookRequest, type TenantFixture, type TestContext } from './helpers';

/**
 * The live coupon lookup (S7): during the stream an operator types each
 * extract and sees whether the coupon was sold, whether it plays the draw or
 * holds an award, and the holder's name, city and chances only under the
 * winner publicity consent (T6). Never document, email, phone or address.
 */
let ctx: TestContext;
let tenant: TenantFixture;
let other: TenantFixture;

interface Lookup {
	campaign: { id: string; title: string; entryDigits: number; round: number; status: string };
	coupon: { entryNumber: number; label: string };
	outcome: 'not_sold' | 'void' | 'eligible';
	manifest: { round: number; status: 'eligible' | 'void' | null } | null;
	awards: { prize: string; position: number; slot: number; round: number; role: 'winner' | 'alternate'; rank: number; status: string }[];
	identity: { visibility: 'shown'; name: string; city: string | null; chances: number } | { visibility: 'withheld' } | { visibility: 'not_applicable' };
}

const buyer = (document: string, firstName: string, city: string) => ({
	documentType: 'DNI',
	documentNumber: document,
	firstName,
	lastName: 'Sorteada',
	email: `${firstName.toLowerCase()}@example.com`,
	phone: '+54 9 11 5555-0000',
	province: 'Neuquén',
	city
});
const consents = (winnerPublicity: boolean) => ({ terms: true, privacy: true, marketingEmail: false, winnerPublicity });
// Whatever the role and the consent, none of this may ever appear.
const forbiddenData = /31\.?000\.?0|@example\.com|5555|Neuquén|DNI|documentNumber|email|phone/;

async function paidOrder(target: TenantFixture, overrides: Record<string, unknown>) {
	ctx.clock.now = new Date(ctx.clock.now.getTime() + 60_000);
	const order = await placeOrder(ctx, target, overrides);
	const payment = ctx.simulator.pay(order.preferenceId, 'approved');
	expect((await ctx.app.inject(webhookRequest(target, payment.id))).statusCode).toBe(200);
	return { ...order, paymentId: payment.id };
}

async function couponsOf(reference: string): Promise<number[]> {
	const order = await orderByReference(ctx, tenant, reference);
	const rows = await ctx.db.withTenant(tenant.id, (tx) => tx.select({ number: s.participationEntries.entryNumber }).from(s.participationEntries).where(eq(s.participationEntries.orderId, order.id)));
	return rows.map((row) => row.number).sort((a, b) => a - b);
}

async function lookup(coupon: string, options: { as?: string; target?: TenantFixture; campaignId?: string } = {}) {
	const target = options.target ?? tenant;
	const auth = await adminHeaders(ctx, target, options.as ?? target.operatorId);
	return ctx.app.inject({ method: 'GET', url: `/admin/campaigns/${options.campaignId ?? target.campaignId}/coupon-lookup?coupon=${encodeURIComponent(coupon)}`, headers: auth });
}

async function found(coupon: string, as?: string): Promise<Lookup> {
	const response = await lookup(coupon, { as });
	expect(response.statusCode, response.body).toBe(200);
	expect(response.body).not.toMatch(forbiddenData);
	return response.json() as Lookup;
}

const coupons = {} as Record<'ana' | 'berta' | 'voided', number[]>;
let anaOrderId: string;
let auditorId: string;

beforeAll(async () => {
	ctx = await createTestContext();
	tenant = await createTenant(ctx, 'livelookup');
	other = await createTenant(ctx, 'livelookup-other');
	auditorId = randomUUID();
	await ctx.db.withPlatform((db) => db.insert(s.organizationMembers).values({ organizationId: tenant.id, userId: auditorId, email: `auditor@${tenant.host}`, role: 'auditor' }));
	await openCampaign(ctx, tenant);
	await openCampaign(ctx, other);

	// Ana consents on both purchases (2 + 1 chances); Berta does not; Carla's purchase is refunded, so her coupons are void.
	const ana = await paidOrder(tenant, { buyer: buyer('31.000.001', 'Ana', 'Zapala'), consents: consents(true) });
	const berta = await paidOrder(tenant, { buyer: buyer('31.000.002', 'Berta', 'Chos Malal'), consents: consents(false) });
	const carla = await paidOrder(tenant, { buyer: buyer('31.000.003', 'Carla', 'Plottier'), consents: consents(true) });
	ctx.simulator.setStatus(carla.paymentId, 'refunded');
	expect((await ctx.app.inject(webhookRequest(tenant, carla.paymentId))).statusCode).toBe(200);
	await paidOrder(tenant, { buyer: buyer('31.000.001', 'Ana', 'Zapala'), lines: [{ variantId: tenant.manualVariantId, quantity: 1 }], consents: consents(true) });
	coupons.ana = await couponsOf(ana.reference);
	anaOrderId = (await orderByReference(ctx, tenant, ana.reference)).id;
	coupons.berta = await couponsOf(berta.reference);
	coupons.voided = await couponsOf(carla.reference);
	// The other organization sells more coupons than this one: 0000-0011.
	for (let order = 0; order < 3; order++) {
		await paidOrder(other, { buyer: buyer('31.000.009', 'Otra', 'Neuquén'), lines: [{ variantId: other.manualVariantId, quantity: 4 }], consents: consents(true) });
	}
});
afterAll(() => ctx.close());

describe('coupon lookup while the campaign sells (S7)', () => {
	it('reads the coupon as typed: "42", "0042", with spaces or its label', async () => {
		const [first] = coupons.ana;
		for (const typed of [String(first), `000${first}`, ` 0 0 0${first} `, `N.º 000${first}`]) {
			const result = await found(typed);
			expect(result.coupon).toEqual({ entryNumber: first, label: `000${first}` });
		}
	});

	it('says a sold coupon is eligible, with no manifest yet and no identity before the draw', async () => {
		const result = await found(String(coupons.ana[0]));
		expect(result).toMatchObject({ outcome: 'eligible', manifest: null, awards: [], identity: { visibility: 'not_applicable' } });
		expect(result.campaign).toMatchObject({ id: tenant.campaignId, entryDigits: 4, round: 1, status: 'open' });
		expect(JSON.stringify(result)).not.toMatch(/Ana|Zapala/);
	});

	it('answers "not sold" for a coupon nobody bought, as a result and not an error', async () => {
		expect(await found('9999')).toMatchObject({ coupon: { entryNumber: 9_999, label: '9999' }, outcome: 'not_sold', manifest: null, awards: [], identity: { visibility: 'not_applicable' } });
	});

	it('refuses an empty value, letters and numbers outside the pool with a Spanish message', async () => {
		for (const typed of ['', 'abc', '10000', '-1']) {
			const response = await lookup(typed);
			expect(response.statusCode, typed).toBe(400);
			expect(response.json().error).toMatchObject({ code: 'invalid_coupon' });
		}
		expect((await lookup('10000')).json().error.message).toBe('Los cupones de esta campaña van del 0000 al 9999');
		expect((await lookup('abc')).json().error.message).toBe('Escribí el número de cupón, por ejemplo 0042');
	});

	it('gives the screen its campaign context without any coupon or holder', async () => {
		const auth = await adminHeaders(ctx, tenant, tenant.operatorId);
		const response = await ctx.app.inject({ method: 'GET', url: `/admin/campaigns/${tenant.campaignId}/coupon-lookup/context`, headers: auth });
		expect(response.statusCode, response.body).toBe(200);
		expect(response.json()).toEqual({ id: tenant.campaignId, title: 'Moto 0 km', status: 'open', entryDigits: 4, round: 1 });
		const auditor = await adminHeaders(ctx, tenant, auditorId);
		expect((await ctx.app.inject({ method: 'GET', url: `/admin/campaigns/${tenant.campaignId}/coupon-lookup/context`, headers: auditor })).statusCode).toBe(403);
		const foreign = await ctx.app.inject({ method: 'GET', url: `/admin/campaigns/${other.campaignId}/coupon-lookup/context`, headers: auth });
		expect(foreign.statusCode).toBe(404);
	});

	it('is for campaign operators, admins and owners; other roles are refused', async () => {
		expect((await lookup('0000', { as: tenant.ownerId })).statusCode).toBe(200);
		expect((await lookup('0000', { as: auditorId })).statusCode).toBe(403);
		const anonymous = await ctx.app.inject({ method: 'GET', url: `/admin/campaigns/${tenant.campaignId}/coupon-lookup?coupon=0000`, headers: headers(tenant) });
		expect(anonymous.statusCode).toBe(401);
	});

	it("never finds another organization's campaign or coupons", async () => {
		// Coupon 0011 exists only in the other organization's campaign.
		expect(await found('0011')).toMatchObject({ outcome: 'not_sold', identity: { visibility: 'not_applicable' } });
		expect((await lookup('0000', { campaignId: other.campaignId })).statusCode).toBe(404);
		expect((await lookup('0000', { target: other, campaignId: tenant.campaignId })).statusCode).toBe(404);
	});

	it('records each search in the audit log without personal data', async () => {
		await found(String(coupons.ana[0]));
		const rows = await ctx.db.withTenant(tenant.id, (tx) =>
			tx.select().from(s.auditEvents).where(and(eq(s.auditEvents.action, 'campaign.coupon_looked_up'), eq(s.auditEvents.targetId, tenant.campaignId)))
		);
		expect(rows.length).toBeGreaterThan(0);
		expect(rows.at(-1)).toMatchObject({ actorType: 'admin', actorId: tenant.operatorId, targetType: 'campaign', metadata: { entryNumber: coupons.ana[0], outcome: 'eligible', identity: 'not_applicable' } });
		expect(JSON.stringify(rows)).not.toMatch(/Ana|Zapala|Berta|Chos Malal/);
		expect(JSON.stringify(rows)).not.toMatch(forbiddenData);
	});
});

describe('coupon lookup on draw night (S7)', () => {
	beforeAll(async () => {
		ctx.clock.now = new Date('2026-11-29T01:00:00Z');
		const owner = await adminHeaders(ctx, tenant);
		expect((await ctx.app.inject({ method: 'POST', url: `/admin/campaigns/${tenant.campaignId}/close`, headers: owner })).statusCode).toBe(200);
		expect((await ctx.app.inject({ method: 'POST', url: `/admin/campaigns/${tenant.campaignId}/transition`, headers: owner, payload: { to: 'awarding' } })).statusCode).toBe(200);
	});

	it('shows no identity for a consenting holder whose coupon plays the draw but holds no award yet: the consent covers winning', async () => {
		const result = await found(String(coupons.ana[1]));
		expect(result).toMatchObject({ outcome: 'eligible', manifest: { round: 1, status: 'eligible' }, awards: [], identity: { visibility: 'not_applicable' } });
		expect(JSON.stringify(result)).not.toMatch(/Ana|Zapala/);
	});

	it('shows no identity for a holder who did not consent and holds no award', async () => {
		const result = await found(String(coupons.berta[0]));
		expect(result).toMatchObject({ outcome: 'eligible', manifest: { round: 1, status: 'eligible' }, identity: { visibility: 'not_applicable' } });
		expect(JSON.stringify(result)).not.toMatch(/Berta|Chos Malal/);
	});

	it('says a refunded coupon is void, also in the manifest, and shows no identity even with consent', async () => {
		const result = await found(String(coupons.voided[0]));
		expect(result).toMatchObject({ outcome: 'void', manifest: { round: 1, status: 'void' }, awards: [], identity: { visibility: 'not_applicable' } });
		expect(JSON.stringify(result)).not.toMatch(/Carla|Plottier/);
	});

	it('names the prize a coupon holds, with the identity only under consent', async () => {
		const operator = await adminHeaders(ctx, tenant, tenant.operatorId);
		const event = await ctx.app.inject({
			method: 'POST',
			url: `/admin/campaigns/${tenant.campaignId}/draw-events`,
			headers: operator,
			payload: { kind: 'mechanism_recorded', title: 'Quiniela de la Ciudad, Nocturna', occurredAt: ctx.clock.now.toISOString() }
		});
		expect(event.statusCode).toBe(200);
		const prizes = await ctx.db.withTenant(tenant.id, (tx) => tx.select().from(s.prizes).where(eq(s.prizes.campaignId, tenant.campaignId)));
		const prizeOf = (kind: string) => prizes.find((prize) => prize.kind === kind)!.id;
		const record = (prizeId: string, winner: number, alternates: number[] = []) =>
			ctx.app.inject({ method: 'PUT', url: `/admin/campaigns/${tenant.campaignId}/awards/${prizeId}/slots/1`, headers: operator, payload: { winner, alternates } });
		expect((await record(prizeOf('vehicle'), coupons.ana[0]!, [coupons.berta[1]!])).statusCode).toBe(200);
		expect((await record(prizeOf('cash'), coupons.berta[0]!)).statusCode).toBe(200);

		const ana = await found(String(coupons.ana[0]));
		expect(ana.awards).toEqual([{ prize: 'Moto', position: 1, slot: 1, round: 1, role: 'winner', rank: 1, status: 'pending_verification' }]);
		expect(ana.identity).toEqual({ visibility: 'shown', name: 'Ana Sorteada', city: 'Zapala', chances: 3 });

		const berta = await found(String(coupons.berta[0]));
		expect(berta.awards).toEqual([{ prize: '$100.000', position: 2, slot: 1, round: 1, role: 'winner', rank: 1, status: 'pending_verification' }]);
		expect(berta.identity).toEqual({ visibility: 'withheld' });
		const alternate = await found(String(coupons.berta[1]));
		expect(alternate.awards).toEqual([{ prize: 'Moto', position: 1, slot: 1, round: 1, role: 'alternate', rank: 1, status: 'pending_verification' }]);
		expect(alternate.identity).toEqual({ visibility: 'withheld' });
	});

	it('gives an owner, who may see personal data elsewhere, exactly the same answer', async () => {
		const asOperator = await found(String(coupons.ana[0]));
		const asOwner = await found(String(coupons.ana[0]), tenant.ownerId);
		expect(asOwner).toEqual(asOperator);
	});

	it('withholds the identity once the holder withdrew the consent on request (S9)', async () => {
		const withdrawn = await ctx.app.inject({ method: 'POST', url: `/admin/orders/${anaOrderId}/winner-publicity/withdraw`, headers: await adminHeaders(ctx, tenant) });
		expect(withdrawn.statusCode, withdrawn.body).toBe(200);
		const ana = await found(String(coupons.ana[0]));
		expect(ana.awards).toHaveLength(1);
		expect(ana.identity).toEqual({ visibility: 'withheld' });
		expect(JSON.stringify(ana)).not.toMatch(/Ana|Zapala/);
	});

	it('still answers "not sold" for a coupon nobody bought', async () => {
		expect(await found('0 0 9 9')).toMatchObject({ coupon: { entryNumber: 99, label: '0099' }, outcome: 'not_sold', manifest: { round: 1, status: null }, awards: [], identity: { visibility: 'not_applicable' } });
	});
});
