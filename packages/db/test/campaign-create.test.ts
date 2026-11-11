import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createCampaign, createDatabase, eq, schema as s, type DatabaseHandle } from '../src';

/**
 * createCampaign, shared by POST /admin/campaigns and client packs (S5, owner
 * feedback 2026-11-10), and migration 0020: a draft may wait for its dates,
 * a campaign people can see may not.
 */
let handle: DatabaseHandle;
const orgA = randomUUID();
const orgB = randomUUID();

const settings = {
	contact: {},
	social: {},
	delivery: { pickupEnabled: false, shippingEnabled: false, shippingFeeMinor: 0 },
	legal: { termsVersion: 't', privacyVersion: 'p' }
};

const draft = {
	slug: 'honda-wave',
	title: 'Honda Wave 0 km',
	subtitle: null,
	summary: 'Sorteamos una Honda Wave 0 km.',
	status: 'draft' as const,
	timezone: 'America/Argentina/Buenos_Aires',
	opensAt: null,
	closesAt: null,
	drawAt: null,
	isDemo: false,
	seo: {},
	rulesMarkdown: 'Bases iniciales de la campaña, en borrador.',
	eligibility: { minAge: 18, residency: 'República Argentina', excluded: [] },
	entriesPerUnit: {}
};

beforeAll(async () => {
	handle = createDatabase(inject('databaseUrl'), { max: 2 });
	await handle.withPlatform((db) =>
		db.insert(s.organizations).values([
			{ id: orgA, slug: `cc-a-${orgA.slice(0, 8)}`, name: 'A', orderPrefix: 'CA', settings },
			{ id: orgB, slug: `cc-b-${orgB.slice(0, 8)}`, name: 'B', orderPrefix: 'CB', settings }
		])
	);
});
afterAll(() => handle.close());

describe('createCampaign', () => {
	let campaignId: string;

	it('creates a draft without dates, its approvals pending and version 1 of the rules in draft', async () => {
		campaignId = await handle.withTenant(orgA, (tx) => createCampaign(tx, orgA, draft));
		const [campaign, approvals, rules] = await handle.withTenant(orgA, (tx) =>
			Promise.all([
				tx.select().from(s.campaigns).where(eq(s.campaigns.id, campaignId)),
				tx.select().from(s.campaignApprovals).where(eq(s.campaignApprovals.campaignId, campaignId)).orderBy(s.campaignApprovals.kind),
				tx.select().from(s.campaignRuleVersions).where(eq(s.campaignRuleVersions.campaignId, campaignId))
			])
		);
		expect(campaign[0]).toMatchObject({ status: 'draft', opensAt: null, closesAt: null, drawAt: null, isDemo: false, requiredApprovals: ['legal', 'psp'] });
		expect(approvals.map((approval) => [approval.kind, approval.status, approval.decidedAt])).toEqual([
			['legal', 'pending', null],
			['psp', 'pending', null]
		]);
		expect(rules.map((rule) => [rule.version, rule.status, rule.bodyMarkdown])).toEqual([[1, 'draft', draft.rulesMarkdown]]);
	});

	it('keeps it inside its organization', async () => {
		const seen = await handle.withTenant(orgB, (tx) => tx.select().from(s.campaigns).where(eq(s.campaigns.id, campaignId)));
		expect(seen).toEqual([]);
	});

	it('the database refuses to publish a campaign without dates, created or moved there', async () => {
		await expect(handle.withTenant(orgA, (tx) => createCampaign(tx, orgA, { ...draft, slug: 'sin-fechas', status: 'published' }))).rejects.toThrow();
		await expect(handle.withTenant(orgA, (tx) => tx.update(s.campaigns).set({ status: 'published' }).where(eq(s.campaigns.id, campaignId)))).rejects.toThrow();
		await handle.withTenant(orgA, (tx) => tx.update(s.campaigns).set({ status: 'review' }).where(eq(s.campaigns.id, campaignId)));
		const [row] = await handle.withTenant(orgA, (tx) => tx.select({ status: s.campaigns.status }).from(s.campaigns).where(eq(s.campaigns.id, campaignId)));
		expect(row!.status).toBe('review');
	});
});
