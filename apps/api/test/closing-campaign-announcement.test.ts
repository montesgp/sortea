import { randomUUID } from 'node:crypto';
import { schema as s } from '@sortea/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminHeaders, createTenant, createTestContext, headers, openCampaign, type TenantFixture, type TestContext } from './helpers';

// Owner feedback 2026-11-15 S3: the site's announcement bar can show, instead of
// its own text, the campaign accepting participations that closes first, linked
// to the shop. The organization turns it on in the "Aviso" block; off by default.

let ctx: TestContext;
let tenant: TenantFixture;

const announcement = { enabled: true, text: 'Estamos en un sitio de pruebas', linkUrl: null, linkLabel: null };

async function publishAnnouncement(content: Record<string, unknown>) {
	const auth = await adminHeaders(ctx, tenant);
	const saved = await ctx.app.inject({ method: 'PUT', url: '/admin/cms/blocks/announcement', headers: auth, payload: { content } });
	expect(saved.statusCode, saved.body).toBe(200);
	const published = await ctx.app.inject({ method: 'POST', url: '/admin/cms/blocks/announcement/publish', headers: auth });
	expect(published.statusCode, published.body).toBe(200);
}

async function site() {
	const response = await ctx.app.inject({ method: 'GET', url: '/public/site', headers: headers(tenant) });
	expect(response.statusCode).toBe(200);
	return response.json() as { content: { announcement?: Record<string, unknown> }; closingCampaign: unknown };
}

/** A second campaign accepting participations, approved and with locked rules, closing on `closesAt`. */
async function addOpenCampaign(slug: string, title: string, closesAt: Date) {
	const campaignId = randomUUID();
	await ctx.db.withPlatform(async (db) => {
		await db.insert(s.campaigns).values({
			id: campaignId,
			organizationId: tenant.id,
			slug,
			title,
			summary: 'Otra campaña de prueba',
			status: 'open',
			timezone: 'America/Argentina/Buenos_Aires',
			opensAt: new Date('2026-10-20T00:00:00Z'),
			closesAt
		});
		await db.insert(s.campaignApprovals).values(
			(['legal', 'psp'] as const).map((kind) => ({
				organizationId: tenant.id,
				campaignId,
				kind,
				status: 'approved' as const,
				reference: `EXP-${kind}-2`,
				authority: 'Autoridad de prueba',
				decidedAt: new Date('2026-10-19T00:00:00Z'),
				decidedBy: tenant.ownerId
			}))
		);
		await db.insert(s.campaignRuleVersions).values({
			organizationId: tenant.id,
			campaignId,
			version: 1,
			status: 'locked',
			bodyMarkdown: 'Bases de la segunda campaña de prueba.',
			eligibility: { minAge: 18, residency: 'AR', excluded: [] },
			entryRule: { mode: 'per_unit', entriesPerUnit: { [tenant.manualVariantId]: 1 }, maxEntriesPerIdentity: null },
			lockedAt: new Date('2026-10-19T00:00:00Z'),
			approvedBy: tenant.ownerId
		});
	});
}

beforeAll(async () => {
	ctx = await createTestContext();
	tenant = await createTenant(ctx, 'closing-bar');
});
afterAll(() => ctx.close());

describe('announcement bar: the campaign closing first (S3)', () => {
	it('is off by default: an announcement saved without the option keeps showing its own text and no campaign', async () => {
		await publishAnnouncement(announcement);
		const result = await site();
		expect(result.content.announcement).toEqual({ ...announcement, showClosingCampaign: false });
		expect(result.closingCampaign).toBeNull();
	});

	it('names no campaign while none accepts participations, even with the option on', async () => {
		await publishAnnouncement({ ...announcement, showClosingCampaign: true });
		const result = await site();
		expect(result.content.announcement).toMatchObject({ showClosingCampaign: true });
		expect(result.closingCampaign).toBeNull();
	});

	it('names the campaign accepting participations, with its closing date', async () => {
		await openCampaign(ctx, tenant);
		expect((await site()).closingCampaign).toEqual({ slug: 'moto', title: 'Moto 0 km', closesAt: '2026-11-28T23:00:00.000Z' });
	});

	it('names the one that closes first when several accept participations', async () => {
		await addOpenCampaign('corta', 'Campaña corta', new Date('2026-11-21T23:00:00Z'));
		expect((await site()).closingCampaign).toEqual({ slug: 'corta', title: 'Campaña corta', closesAt: '2026-11-21T23:00:00.000Z' });
	});

	it('names none when the option is off again', async () => {
		await publishAnnouncement({ ...announcement, showClosingCampaign: false });
		expect((await site()).closingCampaign).toBeNull();
	});
});
