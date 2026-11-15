import { asc, eq, or, schema as s } from '@sortea/db';
import { openSecret } from '@sortea/domain/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTenant, createTestContext, headers, openCampaign, placeOrder, webhookRequest, type TenantFixture, type TestContext } from './helpers';

// Owner feedback 2026-11-15b S4 (decisions L4-L5): a document that bought with several emails gets
// a code at each of them, each its own. A code opens the purchases made with its email; the
// document's first email opens all of them. So typing someone else's document next to your own
// email never shows their purchases. The answer to the start stays the same for every document.

let ctx: TestContext;
let tenant: TenantFixture;
const orders: Record<string, Awaited<ReturnType<typeof placeOrder>>> = {};

const buyer = (email: string) => ({
	buyer: { documentType: 'DNI', documentNumber: '30.123.456', firstName: 'Juana', lastName: 'Pérez', email, phone: '+54 9 11 2345-6789', province: 'Córdoba', city: 'Río Cuarto' }
});

async function pay(order: Awaited<ReturnType<typeof placeOrder>>) {
	const payment = ctx.simulator.pay(order.checkoutId, 'approved');
	await ctx.app.inject(webhookRequest(tenant, payment.id));
}

async function start(documentNumber = '30123456') {
	const response = await ctx.app.inject({ method: 'POST', url: '/lookup/start', headers: headers(tenant), payload: { documentType: 'DNI', documentNumber } });
	expect(response.statusCode).toBe(200);
	return response.json() as { challengeId: string; message: string };
}

/** The code each address would receive, read from the sealed outbox payloads of the challenge's group. */
async function codesFor(challengeId: string): Promise<Record<string, string>> {
	return ctx.db.withTenant(tenant.id, async (tx) => {
		const rows = await tx
			.select({ id: s.lookupChallenges.id, email: s.lookupChallenges.email, contactEmail: s.contacts.email })
			.from(s.lookupChallenges)
			.leftJoin(s.contacts, eq(s.contacts.id, s.lookupChallenges.contactId))
			.where(or(eq(s.lookupChallenges.groupId, challengeId), eq(s.lookupChallenges.id, challengeId)))
			.orderBy(asc(s.lookupChallenges.createdAt));
		const codes: Record<string, string> = {};
		for (const row of rows) {
			const [event] = await tx.select().from(s.outboxEvents).where(eq(s.outboxEvents.dedupeKey, `lookup.otp:${row.id}`));
			if (event) codes[row.email ?? row.contactEmail!] = openSecret(ctx.deps.keyRing, String(event.payload.sealedCode), `otp:${row.id}`);
		}
		return codes;
	});
}

/** Moves the document's earlier requests out of the last hour, so the hourly cap starts again. */
async function freshHour() {
	await ctx.db.withTenant(tenant.id, async (tx) => {
		const [contact] = await tx.select({ id: s.contactIdentifiers.contactId }).from(s.contactIdentifiers).where(eq(s.contactIdentifiers.documentNumber, '30123456'));
		await tx.update(s.lookupChallenges).set({ createdAt: new Date(ctx.clock.now.getTime() - 2 * 3_600_000) }).where(eq(s.lookupChallenges.contactId, contact!.id));
	});
}

async function verify(challengeId: string, code: string) {
	return ctx.app.inject({ method: 'POST', url: '/lookup/verify', headers: headers(tenant), payload: { challengeId, code } });
}

async function references(token: string): Promise<string[]> {
	const me = await ctx.app.inject({ method: 'GET', url: '/lookup/me', headers: headers(tenant, { 'x-lookup-token': token }) });
	expect(me.statusCode).toBe(200);
	return (me.json().orders as { reference: string }[]).map((order) => order.reference).sort();
}

beforeAll(async () => {
	ctx = await createTestContext();
	tenant = await createTenant(ctx, 'several-emails');
	await openCampaign(ctx, tenant);
	orders.first = await placeOrder(ctx, tenant, buyer('juana@example.com'));
	await pay(orders.first);
	orders.second = await placeOrder(ctx, tenant, buyer('Juana.Otra@Example.com'));
	await pay(orders.second);
	// Someone typed Juana's document with their own email and never paid.
	orders.intruder = await placeOrder(ctx, tenant, buyer('intruso@example.com'));
});
afterAll(() => ctx.close());

describe('lookup codes for a document with several emails (S4)', () => {
	// Each test starts below the hourly cap of three requests.
	beforeEach(freshHour);

	it('sends a code to each email used with the document, each its own, and answers like any document', async () => {
		const known = await start();
		const unknown = await start('40999888');
		expect(known.message).toBe(unknown.message);
		expect(Object.keys(known)).toEqual(Object.keys(unknown));
		const codes = await codesFor(known.challengeId);
		expect(Object.keys(codes).sort()).toEqual(['intruso@example.com', 'juana.otra@example.com', 'juana@example.com']);
		expect(new Set(Object.values(codes)).size).toBe(3);
		expect(await codesFor(unknown.challengeId)).toEqual({});
	});

	it("the document's first email opens every purchase", async () => {
		const { challengeId } = await start();
		const codes = await codesFor(challengeId);
		const verified = await verify(challengeId, codes['juana@example.com']!);
		expect(verified.statusCode).toBe(200);
		expect(await references(verified.json().token)).toEqual([orders.first!.reference, orders.intruder!.reference, orders.second!.reference].sort());
	});

	it('another email opens only the purchases made with it, and its downloads only', async () => {
		const { challengeId } = await start();
		const codes = await codesFor(challengeId);
		const verified = await verify(challengeId, codes['juana.otra@example.com']!);
		expect(verified.statusCode).toBe(200);
		const token = verified.json().token;
		expect(await references(token)).toEqual([orders.second!.reference]);

		const me = (await ctx.app.inject({ method: 'GET', url: '/lookup/me', headers: headers(tenant, { 'x-lookup-token': token }) })).json();
		const own = me.orders[0];
		const granted = await ctx.app.inject({ method: 'POST', url: '/lookup/downloads', headers: headers(tenant, { 'x-lookup-token': token }), payload: { orderId: own.id, assetId: own.downloads[0].assetId } });
		expect(granted.statusCode).toBe(200);
		const [first] = await ctx.db.withTenant(tenant.id, (tx) => tx.select({ id: s.orders.id }).from(s.orders).where(eq(s.orders.reference, orders.first!.reference)));
		const refused = await ctx.app.inject({ method: 'POST', url: '/lookup/downloads', headers: headers(tenant, { 'x-lookup-token': token }), payload: { orderId: first!.id, assetId: own.downloads[0].assetId } });
		expect(refused.statusCode).toBe(404);
	});

	it("an email typed next to someone else's document sees nothing of theirs", async () => {
		const { challengeId } = await start();
		const codes = await codesFor(challengeId);
		const verified = await verify(challengeId, codes['intruso@example.com']!);
		expect(verified.statusCode).toBe(200);
		expect(await references(verified.json().token)).toEqual([orders.intruder!.reference]);
	});

	it('one verified code closes the others of the same request', async () => {
		const { challengeId } = await start();
		const codes = await codesFor(challengeId);
		expect((await verify(challengeId, codes['juana.otra@example.com']!)).statusCode).toBe(200);
		expect((await verify(challengeId, codes['juana@example.com']!)).statusCode).toBe(400);
	});

	it('shares the five attempts across the codes of one request', async () => {
		const { challengeId } = await start();
		const codes = await codesFor(challengeId);
		const taken = new Set(Object.values(codes));
		const wrong = ['111111', '222222', '333333', '444444', '555555', '666666', '777777', '888888'].filter((code) => !taken.has(code)).slice(0, 5);
		for (const code of wrong) expect((await verify(challengeId, code)).statusCode).toBe(400);
		expect((await verify(challengeId, codes['juana@example.com']!)).statusCode).toBe(400);
	});

	// Native review of fc032c1: someone who typed Juana's document with their own email could verify
	// their own code, which closed the request, and start again without end, mailing Juana each time.
	// The hourly cap counts every request, used or not.
	it("caps the requests per hour even when someone else's code closes each of them", async () => {
		await freshHour();
		const mailed: number[] = [];
		for (let round = 0; round < 5; round++) {
			const { challengeId } = await start();
			const codes = await codesFor(challengeId);
			mailed.push(Object.keys(codes).length);
			if (codes['intruso@example.com']) expect((await verify(challengeId, codes['intruso@example.com'])).statusCode).toBe(200);
		}
		expect(mailed.map((count) => count > 0)).toEqual([true, true, true, false, false]);
	});

	it('sends to the first email and at most four others, the most recent ones', async () => {
		await freshHour();
		for (const index of [1, 2, 3, 4, 5]) await placeOrder(ctx, tenant, buyer(`extra${index}@example.com`));
		const { challengeId } = await start();
		const codes = await codesFor(challengeId);
		expect(Object.keys(codes).sort()).toEqual(['extra2@example.com', 'extra3@example.com', 'extra4@example.com', 'extra5@example.com', 'juana@example.com']);
	});
});
