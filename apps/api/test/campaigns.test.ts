import { eq, schema as s } from '@sortea/db';
import { sha256Hex } from '@sortea/domain/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	adminHeaders,
	createTenant,
	createTestContext,
	headers,
	placeOrder,
	webhookRequest,
	type TenantFixture,
	type TestContext
} from './helpers';

let ctx: TestContext;
let tenant: TenantFixture;

beforeAll(async () => {
	ctx = await createTestContext();
	tenant = await createTenant(ctx, 'camp');
});
afterAll(() => ctx.close());

const url = (path = '') => `/admin/campaigns/${tenant.campaignId}${path}`;

describe('campaign lifecycle', () => {
	it('AC-12: cannot open without legal and PSP approvals', async () => {
		const response = await ctx.app.inject({ method: 'POST', url: url('/transition'), headers: await adminHeaders(ctx, tenant), payload: { to: 'open' } });
		expect(response.statusCode).toBe(409);
		expect(response.json().error.code).toBe('compliance_gate_closed');
		expect(response.json().error.details.missing).toEqual(['legal', 'psp']);
	});

	it('an approval needs an authority and a reference', async () => {
		const response = await ctx.app.inject({ method: 'PUT', url: url('/approvals/legal'), headers: await adminHeaders(ctx, tenant), payload: { status: 'approved' } });
		expect(response.statusCode).toBe(400);
	});

	it('operators cannot record approvals or change state', async () => {
		const auth = await adminHeaders(ctx, tenant, tenant.operatorId);
		const approval = await ctx.app.inject({ method: 'PUT', url: url('/approvals/legal'), headers: auth, payload: { status: 'approved', reference: 'X', authority: 'Y' } });
		const transition = await ctx.app.inject({ method: 'POST', url: url('/transition'), headers: auth, payload: { to: 'open' } });
		expect([approval.statusCode, transition.statusCode]).toEqual([403, 403]);
	});

	it('AC-06: keeps one vehicle, ten cash and five physical prizes as independent units', async () => {
		const detail = (await ctx.app.inject({ method: 'GET', url: url(), headers: await adminHeaders(ctx, tenant) })).json();
		expect(detail.prizes.map((prize: { kind: string; quantity: number }) => [prize.kind, prize.quantity])).toEqual([
			['vehicle', 1],
			['cash', 10],
			['product', 5]
		]);
	});

	it('opens with approvals and locks the rules', async () => {
		const auth = await adminHeaders(ctx, tenant);
		for (const kind of ['legal', 'psp']) {
			await ctx.app.inject({ method: 'PUT', url: url(`/approvals/${kind}`), headers: auth, payload: { status: 'approved', reference: `EXP-${kind}`, authority: 'Lotería de prueba' } });
		}
		const response = await ctx.app.inject({ method: 'POST', url: url('/transition'), headers: auth, payload: { to: 'open' } });
		expect(response.statusCode).toBe(200);
		const detail = response.json();
		expect(detail.status).toBe('open');
		expect(detail.rules[0].status).toBe('locked');
		expect(detail.rules[0].contentHash).toBe(sha256Hex(detail.rules[0].bodyMarkdown));
	});

	it('AC-08: after opening, rules change only through an announced new version', async () => {
		const auth = await adminHeaders(ctx, tenant);
		const silent = await ctx.app.inject({ method: 'PUT', url: url('/rules'), headers: auth, payload: { bodyMarkdown: 'Bases cambiadas en silencio, sin aviso.' } });
		expect(silent.statusCode).toBe(409);

		const announced = await ctx.app.inject({
			method: 'PUT',
			url: url('/rules'),
			headers: auth,
			payload: { bodyMarkdown: 'Bases versión 2 con el cambio comunicado.', announcement: 'Se corrige la dirección de entrega del premio.' }
		});
		expect(announced.statusCode).toBe(200);
		expect(announced.json().rules.map((rule: { version: number; status: string }) => [rule.version, rule.status])).toEqual([
			[2, 'locked'],
			[1, 'superseded']
		]);
		const transparency = (await ctx.app.inject({ method: 'GET', url: `/public/campaigns/${tenant.campaignSlug}/transparency`, headers: headers(tenant) })).json();
		expect(transparency.ruleVersions).toHaveLength(2);
		expect(transparency.timeline.some((event: { kind: string }) => event.kind === 'rules_updated')).toBe(true);
	});

	it('refuses to close while late payments could still settle', async () => {
		ctx.clock.now = new Date('2026-11-28T23:30:00Z');
		const response = await ctx.app.inject({ method: 'POST', url: url('/close'), headers: await adminHeaders(ctx, tenant) });
		expect(response.statusCode).toBe(409);
		expect(response.json().error.code).toBe('payments_in_transit');
	});

	it('AC-11: closing publishes a manifest whose hash anyone can recompute', async () => {
		ctx.clock.now = new Date('2026-11-20T12:00:00Z');
		for (let index = 0; index < 3; index++) {
			const order = await placeOrder(ctx, tenant, {
				buyer: { documentType: 'DNI', documentNumber: `3100000${index}`, firstName: 'P', lastName: 'Q', email: `p${index}@example.com` }
			});
			const payment = ctx.simulator.pay(order.preferenceId, 'approved');
			await ctx.app.inject(webhookRequest(tenant, payment.id));
		}

		ctx.clock.now = new Date('2026-11-29T01:00:00Z');
		const closed = await ctx.app.inject({ method: 'POST', url: url('/close'), headers: await adminHeaders(ctx, tenant) });
		expect(closed.statusCode).toBe(200);
		expect(closed.json().status).toBe('closed');

		const manifestResponse = await ctx.app.inject({ method: 'GET', url: `/public/campaigns/${tenant.campaignSlug}/manifest`, headers: headers(tenant) });
		const transparency = (await ctx.app.inject({ method: 'GET', url: `/public/campaigns/${tenant.campaignSlug}/transparency`, headers: headers(tenant) })).json();
		expect(sha256Hex(manifestResponse.body)).toBe(transparency.manifest.sha256);
		expect(transparency.manifest.eligibleCount).toBe(6);
		expect(manifestResponse.body).not.toMatch(/3100000|example\.com/);

		const [row] = await ctx.db.withTenant(tenant.id, (tx) => tx.select().from(s.drawManifests).where(eq(s.drawManifests.campaignId, tenant.campaignId)));
		await expect(
			ctx.db.withTenant(tenant.id, (tx) => tx.update(s.drawManifests).set({ content: 'tampered' }).where(eq(s.drawManifests.id, row!.id)))
		).rejects.toThrow();
	});

	it('payments approved after the close add no participations', async () => {
		const [before] = await ctx.db.withTenant(tenant.id, (tx) => tx.select({ next: s.campaigns.nextEntryNumber }).from(s.campaigns));
		ctx.clock.now = new Date('2026-11-29T02:00:00Z');
		const order = await placeOrder(ctx, tenant);
		const payment = ctx.simulator.pay(order.preferenceId, 'approved');
		await ctx.app.inject(webhookRequest(tenant, payment.id));
		const [after] = await ctx.db.withTenant(tenant.id, (tx) => tx.select({ next: s.campaigns.nextEntryNumber }).from(s.campaigns));
		expect(after!.next).toBe(before!.next);
	});
});

describe('admin data exposure', () => {
	it('order lists mask buyer data; detail shows PII only with permission and audits it', async () => {
		const owner = await adminHeaders(ctx, tenant);
		const operator = await adminHeaders(ctx, tenant, tenant.operatorId);
		const list = (await ctx.app.inject({ method: 'GET', url: '/admin/orders', headers: operator })).json();
		expect(list.orders[0].email).toMatch(/\*\*\*@/);
		const id = list.orders[0].id;

		const masked = (await ctx.app.inject({ method: 'GET', url: `/admin/orders/${id}`, headers: operator })).json();
		expect(masked.piiVisible).toBe(false);
		expect(masked.buyer.document).toMatch(/^DNI \*+\d{3}$/);

		const full = (await ctx.app.inject({ method: 'GET', url: `/admin/orders/${id}`, headers: owner })).json();
		expect(full.piiVisible).toBe(true);
		const audits = await ctx.db.withTenant(tenant.id, (tx) => tx.select().from(s.auditEvents).where(eq(s.auditEvents.action, 'order.pii_viewed')));
		expect(audits.length).toBeGreaterThan(0);
	});

	it('the overview reports paid sales and committed prizes', async () => {
		const overview = (await ctx.app.inject({ method: 'GET', url: '/admin/overview', headers: await adminHeaders(ctx, tenant) })).json();
		expect(overview.kpis.paidOrders).toBeGreaterThanOrEqual(3);
		expect(overview.kpis.prizesCommittedMinor).toBe(800_000_000 + 10 * 10_000_000 + 5 * 5_000_000);
		expect(overview.daily).toHaveLength(14);
	});
});
