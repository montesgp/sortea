import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createDatabase, eq, schema as s, type DatabaseHandle } from '../src';

/**
 * Tracking links and order attributions (odd/tasks/tracking-links.md S1, S3): tenant tables,
 * codes unique per organization and never reused, one row per order and link, one last link.
 */
let handle: DatabaseHandle;
const orgA = randomUUID();
const orgB = randomUUID();
const ids = { campaignA: randomUUID(), campaignB: randomUUID(), contactA: randomUUID(), orderA: randomUUID(), linkA: randomUUID(), linkA2: randomUUID() };

const settings = {
	contact: {},
	social: {},
	delivery: { pickupEnabled: false, shippingEnabled: false, shippingFeeMinor: 0 },
	legal: { termsVersion: 't', privacyVersion: 'p' }
};

const campaign = (id: string, organizationId: string) => ({
	id,
	organizationId,
	slug: 'c',
	title: 'C',
	summary: 'S',
	timezone: 'UTC',
	opensAt: new Date('2026-01-01'),
	closesAt: new Date('2026-02-01')
});

/** Drizzle wraps Postgres errors; the database message lives in `cause`. */
async function expectDbError(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
	const error = await promise.then(
		() => null,
		(caught: unknown) => caught
	);
	expect(error, 'expected the database to reject the statement').toBeInstanceOf(Error);
	const cause = (error as Error & { cause?: Error }).cause;
	expect(`${(error as Error).message} ${cause?.message ?? ''}`).toMatch(pattern);
}

beforeAll(async () => {
	handle = createDatabase(inject('databaseUrl'), { max: 3 });
	await handle.withPlatform(async (db) => {
		await db.insert(s.organizations).values([
			{ id: orgA, slug: `ta-${orgA.slice(0, 8)}`, name: 'A', orderPrefix: 'AA', settings },
			{ id: orgB, slug: `tb-${orgB.slice(0, 8)}`, name: 'B', orderPrefix: 'BB', settings }
		]);
		await db.insert(s.campaigns).values([campaign(ids.campaignA, orgA), campaign(ids.campaignB, orgB)]);
		await db.insert(s.contacts).values({ id: ids.contactA, organizationId: orgA, firstName: 'Ana', lastName: 'A', email: 'ana@example.com' });
		await db.insert(s.orders).values({
			id: ids.orderA,
			organizationId: orgA,
			reference: 'AA-T1',
			accessCodeHash: 'x',
			contactId: ids.contactA,
			buyer: { firstName: 'Ana', lastName: 'A', email: 'ana@example.com', phone: null },
			currency: 'ARS',
			subtotalMinor: 100,
			deliveryFeeMinor: 0,
			totalMinor: 100,
			deliveryMethod: 'digital',
			pricingSnapshot: { lines: [], subtotalMinor: 100, deliveryFeeMinor: 0, totalMinor: 100, currency: 'ARS', pricedAt: '' },
			paymentProvider: 'mercadopago',
			expiresAt: new Date()
		});
	});
});

afterAll(async () => {
	await handle.close();
});

describe('tracking links', () => {
	it('belong to a campaign of their organization and are invisible to others', async () => {
		await handle.withTenant(orgA, (tx) =>
			tx.insert(s.trackingLinks).values([
				{ id: ids.linkA, organizationId: orgA, campaignId: ids.campaignA, name: 'Reel A', channel: 'instagram', code: 'aaaa2222' },
				{ id: ids.linkA2, organizationId: orgA, campaignId: ids.campaignA, name: 'Reel B', channel: 'tiktok', code: 'bbbb3333', note: 'historia' }
			])
		);
		const [row] = await handle.withTenant(orgA, (tx) => tx.select().from(s.trackingLinks).where(eq(s.trackingLinks.id, ids.linkA)));
		expect(row).toMatchObject({ campaignId: ids.campaignA, channel: 'instagram', code: 'aaaa2222', archivedAt: null, note: null });
		expect(await handle.withTenant(orgB, (tx) => tx.select().from(s.trackingLinks))).toEqual([]);
		await expectDbError(
			handle.withTenant(orgB, (tx) => tx.insert(s.trackingLinks).values({ organizationId: orgA, campaignId: ids.campaignA, name: 'X', channel: 'other', code: 'cccc4444' })),
			/row-level security/
		);
	});

	it('never repeat a code inside an organization, even after archiving; another organization may use it', async () => {
		await handle.withTenant(orgA, (tx) => tx.update(s.trackingLinks).set({ archivedAt: new Date() }).where(eq(s.trackingLinks.id, ids.linkA)));
		await expectDbError(
			handle.withTenant(orgA, (tx) => tx.insert(s.trackingLinks).values({ organizationId: orgA, campaignId: ids.campaignA, name: 'Otra', channel: 'other', code: 'aaaa2222' })),
			/tracking_links_code_uq|duplicate key/
		);
		await handle.withTenant(orgB, (tx) => tx.insert(s.trackingLinks).values({ organizationId: orgB, campaignId: ids.campaignB, name: 'B', channel: 'youtube', code: 'aaaa2222' }));
	});

	it('are archived, never deleted, so a code is never freed', async () => {
		await expectDbError(handle.withTenant(orgA, (tx) => tx.delete(s.trackingLinks).where(eq(s.trackingLinks.id, ids.linkA))), /append-only/);
	});

	it('only take the known networks', async () => {
		await expectDbError(
			handle.withTenant(orgA, (tx) =>
				tx.insert(s.trackingLinks).values({ organizationId: orgA, campaignId: ids.campaignA, name: 'X', channel: 'myspace' as 'other', code: 'dddd5555' })
			),
			/invalid input value for enum/
		);
	});
});

describe('order attributions', () => {
	it('keep one row per order and link, with a single last link, inside the organization', async () => {
		const at = new Date('2026-01-10T12:00:00Z');
		await handle.withTenant(orgA, (tx) =>
			tx.insert(s.orderAttributions).values([
				{ organizationId: orgA, orderId: ids.orderA, trackingLinkId: ids.linkA, touchedAt: at, isLast: false },
				{ organizationId: orgA, orderId: ids.orderA, trackingLinkId: ids.linkA2, touchedAt: at, isLast: true }
			])
		);
		await expectDbError(
			handle.withTenant(orgA, (tx) => tx.insert(s.orderAttributions).values({ organizationId: orgA, orderId: ids.orderA, trackingLinkId: ids.linkA, touchedAt: at, isLast: false })),
			/order_attributions_uq|duplicate key/
		);
		await expectDbError(
			handle.withTenant(orgA, (tx) => tx.update(s.orderAttributions).set({ isLast: true }).where(eq(s.orderAttributions.trackingLinkId, ids.linkA))),
			/order_attributions_last_uq|duplicate key/
		);
		expect(await handle.withTenant(orgB, (tx) => tx.select().from(s.orderAttributions))).toEqual([]);
		await expectDbError(
			handle.withTenant(orgB, (tx) => tx.insert(s.orderAttributions).values({ organizationId: orgA, orderId: ids.orderA, trackingLinkId: ids.linkA2, touchedAt: at, isLast: false })),
			/row-level security|duplicate key/
		);
	});

	it('leave the order source channel empty unless a purchase without a link records one', async () => {
		const [order] = await handle.withTenant(orgA, (tx) => tx.select().from(s.orders).where(eq(s.orders.id, ids.orderA)));
		expect(order!.sourceChannel).toBeNull();
		await handle.withTenant(orgA, (tx) => tx.update(s.orders).set({ sourceChannel: 'instagram' }).where(eq(s.orders.id, ids.orderA)));
		const [updated] = await handle.withTenant(orgA, (tx) => tx.select({ sourceChannel: s.orders.sourceChannel }).from(s.orders).where(eq(s.orders.id, ids.orderA)));
		expect(updated!.sourceChannel).toBe('instagram');
	});
});
