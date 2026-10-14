import { randomBytes, randomUUID } from 'node:crypto';
import { createDatabase, eq, schema as s, type DatabaseHandle } from '@sortea/db';
import { downloadTokenHash, parseKeyRing, sealSecret } from '@sortea/domain/server';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { NotificationProvider, OutgoingEmail } from '../src/notifications';
import { claimBatch, expireOrders, MAX_ATTEMPTS, processEvent, type WorkerDeps } from '../src/processor';

let db: DatabaseHandle;
const keyRing = parseKeyRing(`v1:${randomBytes(32).toString('base64')}`);
const sent: OutgoingEmail[] = [];
let failing = false;
const clock = { now: new Date('2026-10-25T15:00:00Z') };
const org = randomUUID();
const ids = { contact: randomUUID(), order: randomUUID(), product: randomUUID(), variant: randomUUID(), asset: randomUUID(), challenge: randomUUID() };

const email: NotificationProvider = {
	name: 'memory',
	async send(message) {
		if (failing) throw new Error('smtp down');
		sent.push(message);
		return { messageId: `m-${sent.length}` };
	}
};

function deps(): WorkerDeps {
	return { db, keyRing, email, lookupPepper: 'pepper-for-worker-tests', webFallbackOrigin: 'http://localhost:5173', fromDomain: 'sortea.test', workerId: 'test', now: () => clock.now };
}

async function enqueue(topic: string, payload: Record<string, unknown>) {
	const [event] = await db.withPlatform((database) =>
		database.insert(s.outboxEvents).values({ organizationId: org, topic, dedupeKey: `${topic}:${randomUUID()}`, payload }).returning()
	);
	return event!;
}

async function runOnce() {
	const results = [];
	for (const event of await claimBatch(deps())) results.push(await processEvent(deps(), event));
	return results;
}

beforeAll(async () => {
	db = createDatabase(inject('databaseUrl'), { max: 6 });
	await db.withPlatform(async (database) => {
		await database.insert(s.organizations).values({
			id: org,
			slug: `w-${org.slice(0, 6)}`,
			name: 'MotoGarage',
			orderPrefix: 'MG',
			settings: {
				contact: {},
				social: {},
				delivery: { pickupEnabled: true, shippingEnabled: false, shippingFeeMinor: 0 },
				legal: { termsVersion: 't', privacyVersion: 'p' },
				retentionDays: 30
			}
		});
		await database.insert(s.organizationDomains).values({ organizationId: org, hostname: 'motogarage.example', isPrimary: true });
		await database.insert(s.contacts).values({ id: ids.contact, organizationId: org, firstName: 'Juana', lastName: 'Pérez', email: 'juana@example.com' });
		await database.insert(s.products).values({ id: ids.product, organizationId: org, slug: 'manual', name: 'Manual', description: 'PDF', kind: 'digital', status: 'active' });
		await database.insert(s.productVariants).values({ id: ids.variant, organizationId: org, productId: ids.product, sku: 'M', name: 'Manual', priceMinor: 1_200_000 });
		await database.insert(s.productAssets).values({ id: ids.asset, organizationId: org, productId: ids.product, storagePath: 'x/manual.pdf', filename: 'manual.pdf', contentType: 'application/pdf', sizeBytes: 1 });
		await database.insert(s.orders).values({
			id: ids.order,
			organizationId: org,
			reference: 'MG-TEST0001',
			accessCodeHash: 'x',
			contactId: ids.contact,
			buyer: { firstName: 'Juana', lastName: 'Pérez', email: 'juana@example.com', phone: null },
			status: 'paid',
			currency: 'ARS',
			subtotalMinor: 1_200_000,
			deliveryFeeMinor: 0,
			totalMinor: 1_200_000,
			deliveryMethod: 'digital',
			pricingSnapshot: { lines: [], subtotalMinor: 1_200_000, deliveryFeeMinor: 0, totalMinor: 1_200_000, currency: 'ARS', pricedAt: '' },
			paymentProvider: 'mercadopago',
			expiresAt: clock.now
		});
		await database.insert(s.orderItems).values({
			organizationId: org,
			orderId: ids.order,
			productId: ids.product,
			variantId: ids.variant,
			name: 'Manual',
			kind: 'digital',
			quantity: 1,
			unitPriceMinor: 1_200_000,
			lineTotalMinor: 1_200_000
		});
		await database.insert(s.lookupChallenges).values({
			id: ids.challenge,
			organizationId: org,
			contactId: ids.contact,
			codeHash: 'h',
			expiresAt: new Date(clock.now.getTime() + 10 * 60_000)
		});
	});
});

afterAll(() => db.close());

describe('outbox processing', () => {
	it('emails the lookup code to the contact, opening the sealed payload', async () => {
		sent.length = 0;
		await enqueue('lookup.otp', { challengeId: ids.challenge, contactId: ids.contact, sealedCode: sealSecret(keyRing, '482913', `otp:${ids.challenge}`) });
		expect(await runOnce()).toEqual(['done']);
		expect(sent).toHaveLength(1);
		expect(sent[0]!.to).toBe('juana@example.com');
		expect(sent[0]!.subject).toContain('482913');
		expect(sent[0]!.from).toBe('MotoGarage <no-reply@sortea.test>');
	});

	it('sends the purchase email with working download links on the tenant domain', async () => {
		sent.length = 0;
		await enqueue('order.paid', { orderId: ids.order });
		expect(await runOnce()).toEqual(['done']);
		const link = /https:\/\/motogarage\.example\/descargas\/([A-Za-z0-9_-]+)/.exec(sent[0]!.html);
		expect(link).not.toBeNull();
		const grants = await db.withTenant(org, (tx) => tx.select().from(s.downloadGrants).where(eq(s.downloadGrants.orderId, ids.order)));
		expect(grants.map((grant) => grant.tokenHash)).toContain(downloadTokenHash('pepper-for-worker-tests', link![1]!));
	});

	it('retries with backoff, records attempts and ends in dead letter', async () => {
		sent.length = 0;
		failing = true;
		const event = await enqueue('order.revoked', { orderId: ids.order });
		await db.withPlatform((database) => database.update(s.orders).set({ status: 'refunded' }).where(eq(s.orders.id, ids.order)));

		expect(await runOnce()).toEqual(['retry']);
		const [afterFirst] = await db.withPlatform((database) => database.select().from(s.outboxEvents).where(eq(s.outboxEvents.id, event.id)));
		expect(afterFirst!.status).toBe('pending');
		expect(afterFirst!.availableAt.getTime()).toBeGreaterThan(clock.now.getTime());
		expect(await runOnce()).toEqual([]);

		for (let attempt = 2; attempt <= MAX_ATTEMPTS; attempt++) {
			clock.now = new Date(clock.now.getTime() + 2 * 3_600_000);
			await runOnce();
		}
		const [final] = await db.withPlatform((database) => database.select().from(s.outboxEvents).where(eq(s.outboxEvents.id, event.id)));
		expect(final!.status).toBe('dead');
		expect(final!.lastError).toBe('smtp down');
		const attempts = await db.withTenant(org, (tx) => tx.select().from(s.notificationAttempts));
		expect(attempts.filter((attempt) => !attempt.ok)).toHaveLength(MAX_ATTEMPTS);
		failing = false;
	});

	it('expires unpaid orders past their window', async () => {
		const pending = randomUUID();
		await db.withPlatform((database) =>
			database.insert(s.orders).values({
				id: pending,
				organizationId: org,
				reference: 'MG-TEST0002',
				accessCodeHash: 'x',
				contactId: ids.contact,
				buyer: { firstName: 'J', lastName: 'P', email: 'j@example.com', phone: null },
				currency: 'ARS',
				subtotalMinor: 1,
				deliveryFeeMinor: 0,
				totalMinor: 1,
				deliveryMethod: 'digital',
				pricingSnapshot: { lines: [], subtotalMinor: 1, deliveryFeeMinor: 0, totalMinor: 1, currency: 'ARS', pricedAt: '' },
				paymentProvider: 'mercadopago',
				expiresAt: new Date(clock.now.getTime() - 1000)
			})
		);
		expect(await expireOrders(deps())).toBeGreaterThanOrEqual(1);
		const [row] = await db.withPlatform((database) => database.select().from(s.orders).where(eq(s.orders.id, pending)));
		expect(row!.status).toBe('expired');
	});
});
