import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createDatabase, eq, schema as s, type DatabaseHandle } from '../src';

/** Migration 0014: the `winner_publicity` consent purpose (S5), kept under the tenant policy of `contact_consents`. */
let handle: DatabaseHandle;
const orgA = randomUUID();
const orgB = randomUUID();
const contactA = randomUUID();

const settings = {
	contact: {},
	social: {},
	delivery: { pickupEnabled: false, shippingEnabled: false, shippingFeeMinor: 0 },
	legal: { termsVersion: 't', privacyVersion: 'p' }
};

beforeAll(async () => {
	handle = createDatabase(inject('databaseUrl'), { max: 2 });
	await handle.withPlatform(async (db) => {
		await db.insert(s.organizations).values([
			{ id: orgA, slug: `wp-a-${orgA.slice(0, 8)}`, name: 'A', orderPrefix: 'WA', settings },
			{ id: orgB, slug: `wp-b-${orgB.slice(0, 8)}`, name: 'B', orderPrefix: 'WB', settings }
		]);
		await db.insert(s.contacts).values({ id: contactA, organizationId: orgA, firstName: 'Ana', lastName: 'A', email: 'ana@example.com' });
	});
});
afterAll(() => handle.close());

describe('winner_publicity consent purpose', () => {
	it('records the decision and keeps it inside its organization', async () => {
		await handle.withTenant(orgA, (tx) =>
			tx.insert(s.contactConsents).values({ organizationId: orgA, contactId: contactA, purpose: 'winner_publicity', granted: true, policyVersion: 'p', source: 'checkout' })
		);
		const own = await handle.withTenant(orgA, (tx) => tx.select({ purpose: s.contactConsents.purpose, granted: s.contactConsents.granted }).from(s.contactConsents).where(eq(s.contactConsents.contactId, contactA)));
		expect(own).toEqual([{ purpose: 'winner_publicity', granted: true }]);
		const other = await handle.withTenant(orgB, (tx) => tx.select().from(s.contactConsents).where(eq(s.contactConsents.contactId, contactA)));
		expect(other).toEqual([]);
	});
});
