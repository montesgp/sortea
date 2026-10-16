import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createDatabase, eq, schema as s, sql, type DatabaseHandle } from '../src';

let handle: DatabaseHandle;
const orgA = randomUUID();
const orgB = randomUUID();
const ids = { campaignA: randomUUID(), contactA: randomUUID(), orderA: randomUUID(), entryA: randomUUID(), ruleA: randomUUID() };

const settings = {
	contact: {},
	social: {},
	delivery: { pickupEnabled: false, shippingEnabled: false, shippingFeeMinor: 0 },
	legal: { termsVersion: 't', privacyVersion: 'p' }
};

beforeAll(async () => {
	handle = createDatabase(inject('databaseUrl'), { max: 3 });
	await handle.withPlatform(async (db) => {
		await db.insert(s.organizations).values([
			{ id: orgA, slug: `a-${orgA.slice(0, 8)}`, name: 'A', orderPrefix: 'AA', settings },
			{ id: orgB, slug: `b-${orgB.slice(0, 8)}`, name: 'B', orderPrefix: 'BB', settings }
		]);
		await db.insert(s.campaigns).values({
			id: ids.campaignA,
			organizationId: orgA,
			slug: 'c',
			title: 'C',
			summary: 'S',
			timezone: 'UTC',
			opensAt: new Date('2026-01-01'),
			closesAt: new Date('2026-02-01')
		});
		await db.insert(s.campaignRuleVersions).values({
			id: ids.ruleA,
			organizationId: orgA,
			campaignId: ids.campaignA,
			version: 1,
			status: 'locked',
			bodyMarkdown: 'rules',
			eligibility: { minAge: 18, residency: 'AR', excluded: [] },
			entryRule: { mode: 'per_unit', entriesPerUnit: {}, maxEntriesPerIdentity: null },
			lockedAt: new Date()
		});
		await db.insert(s.contacts).values({ id: ids.contactA, organizationId: orgA, firstName: 'Ana', lastName: 'A', email: 'ana@example.com' });
		await db.insert(s.orders).values({
			id: ids.orderA,
			organizationId: orgA,
			reference: 'AA-1',
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
		await db.insert(s.participationEntries).values({
			id: ids.entryA,
			organizationId: orgA,
			campaignId: ids.campaignA,
			entryNumber: 1,
			contactId: ids.contactA,
			orderId: ids.orderA,
			holderPseudonym: 'h'
		});
		await db.insert(s.entryLedgerEvents).values({ organizationId: orgA, campaignId: ids.campaignA, entryId: ids.entryA, event: 'allocated', reason: 'test' });
	});
});

/** Drizzle wraps Postgres errors; the database message lives in `cause`. */
async function expectDbError(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
	const error = await promise.then(
		() => null,
		(caught: unknown) => caught
	);
	expect(error, "expected the database to reject the statement").toBeInstanceOf(Error);
	const cause = (error as Error & { cause?: Error }).cause;
	expect(`${(error as Error).message} ${cause?.message ?? ""}`).toMatch(pattern);
}

afterAll(async () => {
	await handle.close();
});

describe('row level security', () => {
	it('is enabled with a tenant policy on every table that has organization_id', async () => {
		const rows = await handle.withPlatform((db) =>
			db.execute<{ table_name: string; rls: boolean; policies: number }>(sql`
				select c.relname as table_name, c.relrowsecurity as rls,
					(select count(*)::int from pg_policies p where p.schemaname = 'app' and p.tablename = c.relname) as policies
				from pg_class c
				join pg_namespace n on n.oid = c.relnamespace
				join pg_attribute a on a.attrelid = c.oid and a.attname = 'organization_id' and not a.attisdropped
				where n.nspname = 'app' and c.relkind = 'r'`)
		);
		expect(rows.length).toBeGreaterThan(30);
		const unprotected = rows.filter((row) => !row.rls || row.policies === 0).map((row) => row.table_name);
		expect(unprotected).toEqual([]);
	});

	it('AC-02: hides other tenants rows even when the query has no tenant filter', async () => {
		const seenByB = await handle.withTenant(orgB, (tx) => tx.select().from(s.contacts));
		const seenByA = await handle.withTenant(orgA, (tx) => tx.select().from(s.contacts));
		expect(seenByB).toEqual([]);
		expect(seenByA.map((row) => row.id)).toEqual([ids.contactA]);
	});

	it('AC-02: refuses writes into another tenant', async () => {
		await expectDbError(
			handle.withTenant(orgB, (tx) =>
				tx.insert(s.contacts).values({ organizationId: orgA, firstName: 'X', lastName: 'Y', email: 'x@example.com' })
			),
			/row-level security/
		);
		const updated = await handle.withTenant(orgB, (tx) =>
			tx.update(s.contacts).set({ firstName: 'Hacked' }).where(eq(s.contacts.id, ids.contactA)).returning()
		);
		expect(updated).toEqual([]);
	});

	it('denies everything when no organization is pinned', async () => {
		const rows = await handle.withPlatform((db) =>
			db.transaction(async (tx) => {
				await tx.execute(sql`set local role sortea_app`);
				return tx.select().from(s.contacts);
			})
		);
		expect(rows).toEqual([]);
	});

	it('keeps platform admin records out of the tenant role', async () => {
		await expectDbError(handle.withTenant(orgA, (tx) => tx.select().from(s.platformAdmins)), /permission denied/);
	});
});

describe('append-only evidence', () => {
	it('blocks updates and deletes on the entry ledger', async () => {
		await expectDbError(handle.withTenant(orgA, (tx) => tx.update(s.entryLedgerEvents).set({ reason: 'rewritten' })), /append-only/);
		await expectDbError(handle.withTenant(orgA, (tx) => tx.delete(s.entryLedgerEvents)), /append-only/);
	});

	it('never deletes entries and only allows eligible -> void', async () => {
		await expectDbError(handle.withTenant(orgA, (tx) => tx.delete(s.participationEntries)), /cannot be deleted/);
		await expectDbError(handle.withTenant(orgA, (tx) => tx.update(s.participationEntries).set({ entryNumber: 99 }).where(eq(s.participationEntries.id, ids.entryA))), /immutable/);
		await handle.withTenant(orgA, (tx) => tx.update(s.participationEntries).set({ status: 'void' }).where(eq(s.participationEntries.id, ids.entryA)));
		await expectDbError(handle.withTenant(orgA, (tx) => tx.update(s.participationEntries).set({ status: 'eligible' }).where(eq(s.participationEntries.id, ids.entryA))), /immutable/);
	});

	it('AC-08: a locked rule version cannot be rewritten, only superseded', async () => {
		await expectDbError(handle.withTenant(orgA, (tx) => tx.update(s.campaignRuleVersions).set({ bodyMarkdown: 'silent edit' }).where(eq(s.campaignRuleVersions.id, ids.ruleA))), /immutable/);
		await expectDbError(handle.withTenant(orgA, (tx) => tx.delete(s.campaignRuleVersions)), /cannot be deleted/);
		await handle.withTenant(orgA, (tx) =>
			tx.update(s.campaignRuleVersions).set({ status: 'superseded' }).where(eq(s.campaignRuleVersions.id, ids.ruleA))
		);
	});

	it('blocks audit event tampering', async () => {
		await handle.withTenant(orgA, (tx) =>
			tx.insert(s.auditEvents).values({ organizationId: orgA, actorType: 'test', action: 'a', targetType: 't' })
		);
		await expectDbError(handle.withTenant(orgA, (tx) => tx.delete(s.auditEvents)), /append-only/);
	});

	it('keeps every published version of the site content', async () => {
		await handle.withTenant(orgA, async (tx) => {
			const [block] = await tx
				.insert(s.cmsBlocks)
				.values({ organizationId: orgA, key: 'seo', content: { title: 'A' }, publishedAt: new Date() })
				.returning();
			await tx.insert(s.cmsBlockRevisions).values({ organizationId: orgA, blockId: block!.id, key: 'seo', locale: 'es-AR', version: 1, content: { title: 'A' } });
		});
		await expectDbError(handle.withTenant(orgA, (tx) => tx.update(s.cmsBlockRevisions).set({ content: { title: 'rewritten' } })), /append-only/);
		await expectDbError(handle.withTenant(orgA, (tx) => tx.delete(s.cmsBlockRevisions)), /append-only/);
		expect(await handle.withTenant(orgB, (tx) => tx.select().from(s.cmsBlockRevisions))).toEqual([]);
	});
});
