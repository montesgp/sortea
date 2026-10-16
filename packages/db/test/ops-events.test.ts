import { randomUUID } from 'node:crypto';
import { parseOpsEvent, type OpsEvent } from '@sortea/domain';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createDatabase, eq, OPS_EVENTS_CHANNEL, publishOpsEvent, schema as s, type DatabaseHandle } from '../src';

let handle: DatabaseHandle;
const orgA = randomUUID();
const orgB = randomUUID();
const heard: OpsEvent[] = [];
let stopListening: () => Promise<void>;

const settings = {
	contact: {},
	social: {},
	delivery: { pickupEnabled: false, shippingEnabled: false, shippingFeeMinor: 0 },
	legal: { termsVersion: 't', privacyVersion: 'p' }
};

beforeAll(async () => {
	handle = createDatabase(inject('databaseUrl'), { max: 12 });
	await handle.withPlatform((db) =>
		db.insert(s.organizations).values([
			{ id: orgA, slug: `ops-a-${orgA.slice(0, 8)}`, name: 'A', orderPrefix: 'OA', settings },
			{ id: orgB, slug: `ops-b-${orgB.slice(0, 8)}`, name: 'B', orderPrefix: 'OB', settings }
		])
	);
	const listener = await handle.listen(OPS_EVENTS_CHANNEL, (payload) => {
		const event = parseOpsEvent(payload);
		if (event) heard.push(event);
	});
	stopListening = listener.unlisten;
});
afterAll(async () => {
	await stopListening();
	await handle.close();
});

async function until(condition: () => boolean, timeoutMs = 5_000) {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error('timed out waiting for notifications');
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

describe('live operations feed', () => {
	it('numbers concurrent events per organization without gaps and notifies them in order', async () => {
		const sequences = await Promise.all(
			Array.from({ length: 20 }, () => handle.withTenant(orgA, (tx) => publishOpsEvent(tx, orgA, 'order.updated', randomUUID())))
		);
		expect([...sequences].sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));

		await until(() => heard.filter((event) => event.organizationId === orgA).length === 20);
		const order = heard.filter((event) => event.organizationId === orgA).map((event) => event.sequence);
		expect(order).toEqual([...order].sort((a, b) => a - b));
	});

	it('keeps an independent sequence per organization', async () => {
		expect(await handle.withTenant(orgB, (tx) => publishOpsEvent(tx, orgB, 'campaign.updated'))).toBe(1);
	});

	it('never notifies a change that rolled back', async () => {
		await expect(
			handle.withTenant(orgB, async (tx) => {
				await publishOpsEvent(tx, orgB, 'order.updated');
				throw new Error('abort');
			})
		).rejects.toThrow('abort');
		const next = await handle.withTenant(orgB, (tx) => publishOpsEvent(tx, orgB, 'order.updated'));
		await until(() => heard.some((event) => event.organizationId === orgB && event.sequence === next));
		expect(next).toBe(2);
		expect(heard.filter((event) => event.organizationId === orgB).map((event) => event.sequence)).toEqual([1, 2]);
	});

	it('shows each organization only its own events and does not let tenants rewrite them', async () => {
		const visible = await handle.withTenant(orgB, (tx) => tx.select().from(s.opsEvents));
		expect(visible.every((event) => event.organizationId === orgB)).toBe(true);
		expect(visible).toHaveLength(2);
		await expect(handle.withTenant(orgA, (tx) => tx.update(s.opsEvents).set({ kind: 'campaign.updated' }).where(eq(s.opsEvents.organizationId, orgA)))).rejects.toThrow();
		await expect(handle.withTenant(orgA, (tx) => tx.delete(s.opsEvents).where(eq(s.opsEvents.organizationId, orgA)))).rejects.toThrow();
		// Publishing for another organization from this tenant is refused by RLS.
		await expect(handle.withTenant(orgA, (tx) => publishOpsEvent(tx, orgB, 'order.updated'))).rejects.toThrow();
	});
});
