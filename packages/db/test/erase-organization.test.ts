import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createDatabase, schema as s, type DatabaseHandle } from '../src';
import { ErasureRefusedError, eraseOrganization, planErasure, type OrganizationStorage } from '../src/erase-organization';

let handle: DatabaseHandle;
let client: postgres.Sql;

const settings = {
	contact: {},
	social: {},
	delivery: { pickupEnabled: false, shippingEnabled: false, shippingFeeMinor: 0 },
	legal: { termsVersion: 't', privacyVersion: 'p' }
};

interface Org {
	id: string;
	slug: string;
}

function newOrg(prefix: string): Org {
	const id = randomUUID();
	return { id, slug: `${prefix}-${id.slice(0, 8)}` };
}

const target = newOrg('target');
const other = newOrg('other');
const live = newOrg('live');

/** One row in every kind of table the test cares about, including append-only ones. */
async function seedOrganization(org: Org, mode: 'sandbox' | 'production') {
	const contactId = randomUUID();
	const campaignId = randomUUID();
	const memberUserId = randomUUID();
	await handle.withPlatform(async (db) => {
		await db.insert(s.organizations).values({ id: org.id, slug: org.slug, name: `Org ${org.slug}`, orderPrefix: 'TT', settings });
		await db.insert(s.organizationDomains).values({ organizationId: org.id, hostname: `${org.slug}.example.test` });
		await db.insert(s.organizationMembers).values({ organizationId: org.id, userId: memberUserId, email: `${org.slug}@example.test`, role: 'org_owner' });
		await db.insert(s.organizationIntegrations).values({
			organizationId: org.id,
			provider: 'mercadopago',
			mode,
			sealedSecrets: 'sealed-secret-value-never-logged',
			keyVersion: 1,
			secretHint: 'APP_••••1234'
		});
		await db.insert(s.campaigns).values({
			id: campaignId,
			organizationId: org.id,
			slug: 'c',
			title: 'C',
			summary: 'S',
			timezone: 'UTC',
			opensAt: new Date('2026-01-01'),
			closesAt: new Date('2026-02-01')
		});
		await db.insert(s.contacts).values({ id: contactId, organizationId: org.id, firstName: 'Ana', lastName: 'A', email: `ana@${org.slug}.test` });
		await db.insert(s.contactConsents).values({ organizationId: org.id, contactId, purpose: 'terms', granted: true, policyVersion: 't', source: 'checkout' });
		await db.insert(s.paymentEvents).values({ organizationId: org.id, provider: 'mercadopago', topic: 'payment', signatureValid: true, outcome: 'processed' });
		await db.insert(s.auditEvents).values({ organizationId: org.id, actorType: 'user', action: 'campaign.created', targetType: 'campaign', targetId: campaignId });
	});
}

/** Rows per app table for one organization, read straight from the catalog. */
async function rowsOf(organizationId: string): Promise<Record<string, number>> {
	const tables = await client<{ table_name: string }[]>`
		select c.relname as table_name
		from pg_class c
		join pg_namespace n on n.oid = c.relnamespace
		join pg_attribute a on a.attrelid = c.oid and a.attname = 'organization_id' and not a.attisdropped
		where n.nspname = 'app' and c.relkind = 'r'
		order by 1`;
	const counts: Record<string, number> = {};
	for (const { table_name } of tables) {
		const [row] = await client<{ n: number }[]>`select count(*)::int as n from app.${client(table_name)} where organization_id = ${organizationId}`;
		counts[table_name] = row!.n;
	}
	const [org] = await client<{ n: number }[]>`select count(*)::int as n from app.organizations where id = ${organizationId}`;
	counts.organizations = org!.n;
	return counts;
}

function total(counts: Record<string, number>): number {
	return Object.values(counts).reduce((sum, n) => sum + n, 0);
}

async function erasedAudits(organizationId: string) {
	return client<{ organization_id: string | null; actor_type: string; target_type: string; metadata: Record<string, unknown> }[]>`
		select organization_id, actor_type, target_type, metadata from app.audit_events
		where action = 'organization.erased' and target_id = ${organizationId}`;
}

/** In-memory buckets, so the tests need no storage service. */
function fakeStorage(objects: Record<string, string[]>): OrganizationStorage & { objects: Record<string, string[]> } {
	return {
		objects,
		buckets: Object.keys(objects),
		async list(bucket, prefix) {
			return (objects[bucket] ?? []).filter((path) => path.startsWith(prefix));
		},
		async remove(bucket, paths) {
			objects[bucket] = (objects[bucket] ?? []).filter((path) => !paths.includes(path));
		}
	};
}

async function refusal(promise: Promise<unknown>): Promise<Error> {
	const error = await promise.then(
		() => null,
		(caught: unknown) => caught
	);
	expect(error).toBeInstanceOf(ErasureRefusedError);
	return error as Error;
}

beforeAll(async () => {
	handle = createDatabase(inject('databaseUrl'), { max: 2 });
	client = postgres(inject('databaseUrl'), { max: 1, onnotice: () => {} });
	await seedOrganization(target, 'sandbox');
	await seedOrganization(other, 'sandbox');
	await seedOrganization(live, 'production');
});

afterAll(async () => {
	await client.end();
	await handle.close();
});

describe('organization erasure', () => {
	it('dry run reports the organization, its rows and its files, and deletes nothing', async () => {
		const before = await rowsOf(target.id);
		const storage = fakeStorage({ 'product-assets': [`${target.id}/p/file.pdf`, `${other.id}/p/file.pdf`], 'site-media': [`${target.id}/a.png`, `${target.id}/b.png`] });
		const plan = await planErasure(client, target.slug, storage);
		expect(plan.organization).toEqual({ id: target.id, slug: target.slug, name: `Org ${target.slug}` });
		expect(plan.counts).toMatchObject({ audit_events: 1, payment_events: 1, contact_consents: 1, organization_members: 1, organization_domains: 1, organization_integrations: 1 });
		expect(plan.storageCounts).toEqual({ 'product-assets': 1, 'site-media': 2 });
		expect(plan.productionPaymentIntegrations).toBe(0);
		expect(await rowsOf(target.id)).toEqual(before);
		expect(storage.objects['site-media']).toHaveLength(2);
	});

	it('refuses an unknown slug', async () => {
		const error = await refusal(eraseOrganization(client, { slug: 'no-such-org', confirm: 'no-such-org', allowProduction: false, storage: null }));
		expect(error.message).toMatch(/no-such-org/);
	});

	it('refuses a missing or different confirmation and deletes nothing', async () => {
		const before = await rowsOf(target.id);
		await refusal(eraseOrganization(client, { slug: target.slug, confirm: undefined, allowProduction: false, storage: null }));
		await refusal(eraseOrganization(client, { slug: target.slug, confirm: target.slug.toUpperCase(), allowProduction: false, storage: null }));
		await refusal(eraseOrganization(client, { slug: target.slug, confirm: `${target.slug} `, allowProduction: false, storage: null }));
		expect(await rowsOf(target.id)).toEqual(before);
		expect(await erasedAudits(target.id)).toEqual([]);
	});

	it('refuses an organization with a production Mercado Pago integration unless allowed', async () => {
		const before = await rowsOf(live.id);
		expect((await planErasure(client, live.slug, null)).productionPaymentIntegrations).toBe(1);
		const error = await refusal(eraseOrganization(client, { slug: live.slug, confirm: live.slug, allowProduction: false, storage: null }));
		expect(error.message).toMatch(/production/);
		expect(await rowsOf(live.id)).toEqual(before);

		await eraseOrganization(client, { slug: live.slug, confirm: live.slug, allowProduction: true, storage: null });
		expect(total(await rowsOf(live.id))).toBe(0);
	});

	it('erases every row and file of the organization, leaves the other one intact and audits once', async () => {
		const otherBefore = await rowsOf(other.id);
		const targetBefore = await rowsOf(target.id);
		const storage = fakeStorage({ 'product-assets': [`${target.id}/p/file.pdf`, `${other.id}/p/file.pdf`], 'site-media': [`${target.id}/a.png`] });

		const result = await eraseOrganization(client, { slug: target.slug, confirm: target.slug, allowProduction: false, storage });

		expect(total(await rowsOf(target.id))).toBe(0);
		expect(await rowsOf(other.id)).toEqual(otherBefore);
		const { organizations: _org, ...expectedCounts } = targetBefore;
		expect(result.counts).toEqual(Object.fromEntries(Object.entries(expectedCounts).filter(([, n]) => n > 0)));
		expect(result.storageRemoved).toEqual({ 'product-assets': 1, 'site-media': 1 });
		expect(storage.objects).toEqual({ 'product-assets': [`${other.id}/p/file.pdf`], 'site-media': [] });

		const audits = await erasedAudits(target.id);
		expect(audits).toHaveLength(1);
		expect(audits[0]).toMatchObject({ organization_id: null, actor_type: 'operator', target_type: 'organization' });
		expect(audits[0]!.metadata).toEqual({
			slug: target.slug,
			name: `Org ${target.slug}`,
			counts: result.counts,
			storageCounts: { 'product-assets': 1, 'site-media': 1 }
		});
		expect(JSON.stringify(audits[0])).not.toMatch(/sealed-secret-value|APP_/);

		await refusal(eraseOrganization(client, { slug: target.slug, confirm: target.slug, allowProduction: false, storage: null }));
	});

	it('keeps the append-only protection outside the erasure', async () => {
		const error = await client`delete from app.payment_events where organization_id = ${other.id}`.then(
			() => null,
			(caught: unknown) => caught as Error
		);
		expect(error?.message).toMatch(/append-only/);
	});

	it('rolls back when another organization references its rows', async () => {
		const victim = newOrg('victim');
		const holder = newOrg('holder');
		await seedOrganization(victim, 'sandbox');
		await seedOrganization(holder, 'sandbox');
		const [contact] = await client<{ id: string }[]>`select id from app.contacts where organization_id = ${victim.id}`;
		await client`insert into app.contact_consents (organization_id, contact_id, purpose, granted, policy_version, source)
			values (${holder.id}, ${contact!.id}, 'terms', true, 't', 'checkout')`;
		const before = await rowsOf(victim.id);
		await expect(eraseOrganization(client, { slug: victim.slug, confirm: victim.slug, allowProduction: false, storage: null })).rejects.toThrow(/rolled back/);
		expect(await rowsOf(victim.id)).toEqual(before);
		expect(await erasedAudits(victim.id)).toEqual([]);
	});

	it('reports a failed bucket but keeps the database erasure and cleans the other buckets', async () => {
		const org = newOrg('flaky');
		await seedOrganization(org, 'sandbox');
		const storage = fakeStorage({ 'product-assets': [`${org.id}/x.pdf`], 'site-media': [`${org.id}/a.png`] });
		const remove = storage.remove;
		storage.remove = async (bucket, paths) => {
			if (bucket === 'site-media') throw new Error('boom');
			return remove(bucket, paths);
		};
		const result = await eraseOrganization(client, { slug: org.slug, confirm: org.slug, allowProduction: false, storage });
		expect(total(await rowsOf(org.id))).toBe(0);
		expect(result.storageErrors).toEqual(['site-media: boom']);
		expect(storage.objects).toEqual({ 'product-assets': [], 'site-media': [`${org.id}/a.png`] });
	});
});
