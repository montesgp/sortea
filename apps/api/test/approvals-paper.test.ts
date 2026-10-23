import { randomUUID } from 'node:crypto';
import { eq, schema as s } from '@sortea/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminHeaders, createTenant, createTestContext, headers, type TenantFixture, type TestContext } from './helpers';

/**
 * "Constancia en papel" (ADR 0015): the organization owner attests that every
 * required approval exists on paper. Nothing is invented (no reference, no
 * authority), the change is audited, and it can be undone only while approvals
 * are still editable.
 */
let ctx: TestContext;

beforeAll(async () => {
	ctx = await createTestContext();
});
afterAll(() => ctx.close());

const attestation = (tenant: TenantFixture) => `/admin/campaigns/${tenant.campaignId}/paper-attestation`;

async function attest(tenant: TenantFixture, attested: boolean, userId = tenant.ownerId) {
	return ctx.app.inject({ method: 'PUT', url: attestation(tenant), headers: await adminHeaders(ctx, tenant, userId), payload: { attested } });
}

async function recordDocument(tenant: TenantFixture, kind: 'legal' | 'psp', payload: Record<string, unknown>) {
	return ctx.app.inject({ method: 'PUT', url: `/admin/campaigns/${tenant.campaignId}/approvals/${kind}`, headers: await adminHeaders(ctx, tenant), payload });
}

async function approvalRows(tenant: TenantFixture) {
	const rows = await ctx.db.withTenant(tenant.id, (tx) => tx.select().from(s.campaignApprovals).where(eq(s.campaignApprovals.campaignId, tenant.campaignId)));
	return rows
		.map(({ kind, status, basis, reference, authority, decidedAt, decidedBy }) => ({ kind, status, basis, reference, authority, decidedAt, decidedBy }))
		.sort((a, b) => a.kind.localeCompare(b.kind));
}

async function auditsOf(tenant: TenantFixture, action: string) {
	return ctx.db.withTenant(tenant.id, (tx) => tx.select().from(s.auditEvents).where(eq(s.auditEvents.action, action)));
}

async function addMember(tenant: TenantFixture, role: 'org_admin' | 'campaign_operator') {
	const userId = randomUUID();
	await ctx.db.withPlatform((db) => db.insert(s.organizationMembers).values({ organizationId: tenant.id, userId, email: `${role}-${userId.slice(0, 4)}@${tenant.host}`, role }));
	return userId;
}

describe('paper attestation of approvals', () => {
	it('only the owner can attest or clear: an admin and an operator get 403 and nothing changes', async () => {
		const tenant = await createTenant(ctx, 'paper-rbac');
		const before = await approvalRows(tenant);
		const admin = await addMember(tenant, 'org_admin');
		const responses = [await attest(tenant, true, admin), await attest(tenant, true, tenant.operatorId), await attest(tenant, false, admin)];
		expect(responses.map((response) => response.statusCode)).toEqual([403, 403, 403]);
		expect(await approvalRows(tenant)).toEqual(before);
		expect(await auditsOf(tenant, 'campaign.approvals_attested')).toHaveLength(0);
	});

	it('the owner attests: every required approval is approved on paper with no invented reference, audited, and the campaign can open', async () => {
		ctx.clock.now = new Date('2026-10-22T15:00:00Z');
		const tenant = await createTenant(ctx, 'paper-ok');
		const response = await attest(tenant, true);
		expect(response.statusCode).toBe(200);
		const detail = response.json();
		expect(detail.gate).toEqual({ allowed: true, missing: [], rejected: [] });
		expect(detail.approvals.map((approval: { kind: string; status: string; basis: string; reference: string | null }) => [approval.kind, approval.status, approval.basis, approval.reference]).sort()).toEqual([
			['legal', 'approved', 'paper', null],
			['psp', 'approved', 'paper', null]
		]);

		const decidedAt = new Date('2026-10-22T15:00:00Z');
		expect(await approvalRows(tenant)).toEqual([
			{ kind: 'legal', status: 'approved', basis: 'paper', reference: null, authority: null, decidedAt, decidedBy: tenant.ownerId },
			{ kind: 'psp', status: 'approved', basis: 'paper', reference: null, authority: null, decidedAt, decidedBy: tenant.ownerId }
		]);
		const audits = await auditsOf(tenant, 'campaign.approvals_attested');
		expect(audits).toHaveLength(1);
		expect(audits[0]).toMatchObject({ actorType: 'admin', actorId: tenant.ownerId, targetType: 'campaign', targetId: tenant.campaignId });
		expect(audits[0]!.metadata).toEqual({ kinds: ['legal', 'psp'], previous: { legal: 'pending', psp: 'pending' } });

		const opened = await ctx.app.inject({ method: 'POST', url: `/admin/campaigns/${tenant.campaignId}/transition`, headers: await adminHeaders(ctx, tenant), payload: { to: 'open' } });
		expect(opened.statusCode).toBe(200);
		expect(opened.json().status).toBe('open');
	});

	it('the public campaign page shows a paper approval without a reference and marked as paper', async () => {
		const tenant = await createTenant(ctx, 'paper-public');
		await recordDocument(tenant, 'legal', { status: 'approved', reference: 'EXP-1', authority: 'Lotería de prueba' });
		await attest(tenant, true);
		const page = (await ctx.app.inject({ method: 'GET', url: `/public/campaigns/${tenant.campaignSlug}`, headers: headers(tenant) })).json();
		const byKind = Object.fromEntries(page.compliance.approvals.map((approval: { kind: string }) => [approval.kind, approval]));
		expect(byKind.legal).toMatchObject({ status: 'approved', basis: 'document', authority: 'Lotería de prueba', reference: 'EXP-1' });
		expect(byKind.psp).toMatchObject({ status: 'approved', basis: 'paper', authority: null, reference: null });
		expect(page.compliance.allowed).toBe(true);
	});

	it('attesting leaves approvals already recorded with a reference untouched and overrides a rejection, keeping the previous status in the audit', async () => {
		const tenant = await createTenant(ctx, 'paper-mixed');
		await recordDocument(tenant, 'legal', { status: 'approved', reference: 'EXP-1', authority: 'Lotería de prueba' });
		await recordDocument(tenant, 'psp', { status: 'rejected', notes: 'Falta documentación' });
		const [legalBefore] = await approvalRows(tenant);
		expect((await attest(tenant, true)).statusCode).toBe(200);
		const [legal, psp] = await approvalRows(tenant);
		expect(legal).toEqual(legalBefore);
		expect(psp).toMatchObject({ status: 'approved', basis: 'paper', reference: null, authority: null, decidedBy: tenant.ownerId });
		const [event] = await auditsOf(tenant, 'campaign.approvals_attested');
		expect(event!.metadata).toEqual({ kinds: ['psp'], previous: { psp: 'rejected' } });
	});

	it('clearing returns only the paper approvals to pending and leaves the document ones untouched', async () => {
		const tenant = await createTenant(ctx, 'paper-clear');
		await recordDocument(tenant, 'legal', { status: 'approved', reference: 'EXP-1', authority: 'Lotería de prueba' });
		await attest(tenant, true);
		const [legalBefore] = await approvalRows(tenant);
		const response = await attest(tenant, false);
		expect(response.statusCode).toBe(200);
		expect(response.json().gate).toEqual({ allowed: false, missing: ['psp'], rejected: [] });
		const [legal, psp] = await approvalRows(tenant);
		expect(legal).toEqual(legalBefore);
		expect(psp).toEqual({ kind: 'psp', status: 'pending', basis: 'document', reference: null, authority: null, decidedAt: null, decidedBy: null });
		const cleared = await auditsOf(tenant, 'campaign.approvals_attestation_cleared');
		expect(cleared).toHaveLength(1);
		expect(cleared[0]).toMatchObject({ actorId: tenant.ownerId, targetId: tenant.campaignId });
		expect(cleared[0]!.metadata).toEqual({ kinds: ['psp'] });
	});

	it('once the campaign is open, attesting and clearing are refused with approvals_locked and nothing changes', async () => {
		const tenant = await createTenant(ctx, 'paper-locked');
		await attest(tenant, true);
		await ctx.app.inject({ method: 'POST', url: `/admin/campaigns/${tenant.campaignId}/transition`, headers: await adminHeaders(ctx, tenant), payload: { to: 'open' } });
		const before = await approvalRows(tenant);
		const responses = [await attest(tenant, false), await attest(tenant, true)];
		expect(responses.map((response) => [response.statusCode, response.json().error.code])).toEqual([
			[409, 'approvals_locked'],
			[409, 'approvals_locked']
		]);
		expect(await approvalRows(tenant)).toEqual(before);
		expect(await auditsOf(tenant, 'campaign.approvals_attestation_cleared')).toHaveLength(0);
		expect(await auditsOf(tenant, 'campaign.approvals_attested')).toHaveLength(1);
	});

	it('the per-kind form keeps requiring authority and reference and records a document approval', async () => {
		const tenant = await createTenant(ctx, 'paper-document');
		const missing = await recordDocument(tenant, 'legal', { status: 'approved' });
		expect(missing.statusCode).toBe(400);
		const recorded = await recordDocument(tenant, 'legal', { status: 'approved', reference: 'EXP-1', authority: 'Lotería de prueba' });
		expect(recorded.statusCode).toBe(200);
		const [legal] = await approvalRows(tenant);
		expect(legal).toMatchObject({ status: 'approved', basis: 'document', reference: 'EXP-1', authority: 'Lotería de prueba', decidedBy: tenant.ownerId });
	});

	it('the per-kind form turns a paper approval back into a document one', async () => {
		const tenant = await createTenant(ctx, 'paper-to-document');
		await attest(tenant, true);
		await recordDocument(tenant, 'legal', { status: 'approved', reference: 'EXP-9', authority: 'Lotería de prueba' });
		const [legal, psp] = await approvalRows(tenant);
		expect([legal!.basis, legal!.reference, psp!.basis]).toEqual(['document', 'EXP-9', 'paper']);
	});

	it('attesting twice records the change once', async () => {
		const tenant = await createTenant(ctx, 'paper-twice');
		await attest(tenant, true);
		await attest(tenant, true);
		expect(await auditsOf(tenant, 'campaign.approvals_attested')).toHaveLength(1);
	});
});
