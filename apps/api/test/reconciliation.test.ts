import { randomUUID } from 'node:crypto';
import { and, eq, schema as s } from '@sortea/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	adminHeaders,
	createTenant,
	createTestContext,
	INTERNAL_TOKEN,
	openCampaign,
	orderByReference,
	placeOrder,
	webhookRequest,
	type TenantFixture,
	type TestContext
} from './helpers';

let ctx: TestContext;
let tenant: TenantFixture;
let other: TenantFixture;
const financeId = randomUUID();
const otherFinanceId = randomUUID();

async function addMember(target: TenantFixture, userId: string, role: 'finance_manager' | 'auditor') {
	await ctx.db.withPlatform((db) => db.insert(s.organizationMembers).values({ organizationId: target.id, userId, email: `${role}@${target.host}`, role }));
}

beforeAll(async () => {
	ctx = await createTestContext();
	tenant = await createTenant(ctx, 'recon');
	other = await createTenant(ctx, 'recon-other');
	await openCampaign(ctx, tenant);
	await addMember(tenant, financeId, 'finance_manager');
	await addMember(other, otherFinanceId, 'finance_manager');
});
afterAll(() => ctx.close());

function tick(minutes = 1) {
	ctx.clock.now = new Date(ctx.clock.now.getTime() + minutes * 60_000);
}

const finance = (target = tenant, userId = financeId) => adminHeaders(ctx, target, userId);

/** A checkout paid at the provider. With `notify: false` the webhook is "lost". */
async function pay(options: { notify?: boolean; outcome?: 'approved' | 'rejected' } = {}) {
	tick();
	const order = await placeOrder(ctx, tenant);
	const payment = ctx.simulator.pay(order.preferenceId, options.outcome ?? 'approved');
	if (options.notify !== false) {
		const response = await ctx.app.inject(webhookRequest(tenant, payment.id));
		expect(response.statusCode).toBe(200);
	}
	return { reference: order.reference, paymentId: payment.id, totalMinor: order.totalMinor };
}

async function reconcile(target = tenant, userId = financeId) {
	tick();
	const response = await ctx.app.inject({ method: 'POST', url: '/admin/reconciliation/runs', headers: await finance(target, userId), payload: {} });
	expect(response.statusCode, response.body).toBe(200);
	return response.json() as { status: string; runId: string; summary: { examined: number; matched: number; discrepancies: number; cleared: number } };
}

async function itemsFor(paymentId: string, status: 'open' | 'resolved' = 'open') {
	return ctx.db.withTenant(tenant.id, (tx) =>
		tx
			.select()
			.from(s.reconciliationItems)
			.where(and(eq(s.reconciliationItems.providerPaymentId, paymentId), eq(s.reconciliationItems.status, status)))
	);
}

async function resolve(itemId: string, payload: Record<string, unknown>, userId = financeId) {
	return ctx.app.inject({ method: 'POST', url: `/admin/reconciliation/items/${itemId}/resolve`, headers: await finance(tenant, userId), payload });
}

describe('operations reconciliation (AC-09)', () => {
	it('matches payments that agree and keeps the provider fees and net (FR-PAY-06)', async () => {
		const paid = await pay();
		const run = await reconcile();
		expect(run.status).toBe('completed');
		expect(run.summary.matched).toBeGreaterThanOrEqual(1);
		expect(await itemsFor(paid.paymentId)).toEqual([]);

		const [payment] = await ctx.db.withTenant(tenant.id, (tx) => tx.select().from(s.payments).where(eq(s.payments.providerPaymentId, paid.paymentId)));
		expect(payment!.feeMinor).toBe(Math.round((paid.totalMinor * 629) / 10_000));
		expect(payment!.netMinor).toBe(paid.totalMinor - payment!.feeMinor!);

		const overview = await ctx.app.inject({ method: 'GET', url: '/admin/reconciliation', headers: await finance() });
		const body = overview.json();
		expect(body.finance.grossMinor).toBeGreaterThanOrEqual(paid.totalMinor);
		expect(body.finance.feesMinor).toBeGreaterThan(0);
		// Available balance and payouts are never inferred from approved sales.
		expect(body.finance.availableMinor).toBeNull();
		expect(body.runs[0].status).toBe('completed');
	});

	it('detects a payment whose webhook never arrived and applies it from the provider', async () => {
		const lost = await pay({ notify: false });
		expect((await orderByReference(ctx, tenant, lost.reference)).status).toBe('pending_payment');

		await reconcile();
		const [item] = await itemsFor(lost.paymentId);
		expect(item).toMatchObject({ kind: 'payment_missing_in_system', severity: 'critical', orderReference: lost.reference });

		// A second run updates the same item instead of opening another.
		await reconcile();
		expect(await itemsFor(lost.paymentId)).toHaveLength(1);

		const response = await resolve(item!.id, { action: 'apply_provider_state' });
		expect(response.statusCode, response.body).toBe(200);
		expect(response.json()).toEqual({ outcome: 'paid', resolved: true });

		const order = await orderByReference(ctx, tenant, lost.reference);
		expect(order.status).toBe('paid');
		const entries = await ctx.db.withTenant(tenant.id, (tx) => tx.select().from(s.participationEntries).where(eq(s.participationEntries.orderId, order.id)));
		expect(entries.length).toBeGreaterThan(0);
		const [resolved] = await itemsFor(lost.paymentId, 'resolved');
		expect(resolved).toMatchObject({ resolution: 'provider_state_applied', resolvedBy: financeId });

		await reconcile();
		expect(await itemsFor(lost.paymentId)).toEqual([]);
	});

	it('detects a different amount and only lets a person accept it with a reason', async () => {
		const paid = await pay();
		ctx.simulator.tamper(paid.paymentId, { amountMinor: paid.totalMinor - 100_000 });
		await reconcile();
		const [item] = await itemsFor(paid.paymentId);
		expect(item).toMatchObject({ kind: 'amount_mismatch', expected: { amountMinor: paid.totalMinor }, observed: { amountMinor: paid.totalMinor - 100_000 } });

		expect((await resolve(item!.id, { action: 'apply_provider_state' })).statusCode).toBe(409);
		expect((await resolve(item!.id, { action: 'accept', note: 'corto' })).statusCode).toBe(400);
		const accepted = await resolve(item!.id, { action: 'accept', note: 'Diferencia confirmada con soporte de Mercado Pago, caso 123' });
		expect(accepted.statusCode).toBe(200);
		expect((await resolve(item!.id, { action: 'accept', note: 'Segundo intento de aceptar lo mismo' })).statusCode).toBe(409);

		const audits = await ctx.db.withTenant(tenant.id, (tx) => tx.select().from(s.auditEvents).where(eq(s.auditEvents.targetId, item!.id)));
		expect(audits.map((event) => event.action)).toEqual(['reconciliation.accepted']);
	});

	it('detects a refund the platform missed and revokes the entries through the ledger', async () => {
		const paid = await pay();
		ctx.simulator.setStatus(paid.paymentId, 'refunded');
		await reconcile();
		const [item] = await itemsFor(paid.paymentId);
		expect(item).toMatchObject({ kind: 'refund_not_applied', severity: 'critical' });

		const response = await resolve(item!.id, { action: 'apply_provider_state' });
		expect(response.json()).toEqual({ outcome: 'refunded', resolved: true });
		const order = await orderByReference(ctx, tenant, paid.reference);
		expect(order.status).toBe('refunded');
		const entries = await ctx.db.withTenant(tenant.id, (tx) => tx.select().from(s.participationEntries).where(eq(s.participationEntries.orderId, order.id)));
		expect(entries.every((entry) => entry.status === 'void')).toBe(true);
	});

	it('reports partial refunds and payments the provider does not have', async () => {
		const partial = await pay();
		ctx.simulator.refundPartially(partial.paymentId, 200_000);
		const vanished = await pay();
		ctx.simulator.payments.delete(vanished.paymentId);

		await reconcile();
		expect((await itemsFor(partial.paymentId)).map((item) => item.kind)).toEqual(['partial_refund']);
		expect((await itemsFor(vanished.paymentId)).map((item) => item.kind)).toEqual(['payment_missing_at_provider']);
	});

	it('clears an item when the difference goes away on its own', async () => {
		const late = await pay({ notify: false });
		await reconcile();
		expect(await itemsFor(late.paymentId)).toHaveLength(1);

		// The webhook finally arrives.
		await ctx.app.inject(webhookRequest(tenant, late.paymentId));
		const run = await reconcile();
		expect(run.summary.cleared).toBeGreaterThanOrEqual(1);
		const [cleared] = await itemsFor(late.paymentId, 'resolved');
		expect(cleared).toMatchObject({ resolution: 'cleared', resolvedBy: null });
	});

	it('runs one reconciliation at a time and recovers a stuck run', async () => {
		tick();
		const [stuck] = await ctx.db.withTenant(tenant.id, (tx) =>
			tx
				.insert(s.reconciliationRuns)
				.values({ organizationId: tenant.id, kind: 'operations', trigger: 'manual', windowFrom: ctx.clock.now, windowTo: ctx.clock.now, startedAt: ctx.clock.now })
				.returning()
		);
		const busy = await ctx.app.inject({ method: 'POST', url: '/admin/reconciliation/runs', headers: await finance(), payload: {} });
		expect(busy.statusCode).toBe(409);
		expect(busy.json().error.code).toBe('run_in_progress');

		tick(31);
		expect((await reconcile()).status).toBe('completed');
		const [failed] = await ctx.db.withTenant(tenant.id, (tx) => tx.select().from(s.reconciliationRuns).where(eq(s.reconciliationRuns.id, stuck!.id)));
		expect(failed!.status).toBe('failed');
	});
});

describe('settlement reconciliation (AC-09)', () => {
	const header = 'EXTERNAL_REFERENCE;SOURCE_ID;USER_ID;PAYMENT_METHOD_TYPE;PAYMENT_METHOD;SITE;TRANSACTION_TYPE;TRANSACTION_AMOUNT;TRANSACTION_CURRENCY;TRANSACTION_DATE;FEE_AMOUNT;SETTLEMENT_NET_AMOUNT;SETTLEMENT_CURRENCY;SETTLEMENT_DATE';
	const decimal = (minor: number) => (minor / 100).toFixed(2);
	const line = (reference: string, id: string, type: string, grossMinor: number, netMinor: number, at: Date) =>
		[reference, id, '42', 'credit_card', 'visa', 'MLA', type, decimal(grossMinor), 'ARS', at.toISOString(), decimal(netMinor - grossMinor), decimal(netMinor), 'ARS', at.toISOString()].join(';');

	async function upload(content: string, filename = 'liquidaciones.csv') {
		tick();
		return ctx.app.inject({ method: 'POST', url: '/admin/reconciliation/settlements', headers: await finance(), payload: { filename, content } });
	}

	async function net(paymentId: string) {
		const [payment] = await ctx.db.withTenant(tenant.id, (tx) => tx.select().from(s.payments).where(eq(s.payments.providerPaymentId, paymentId)));
		return payment!.netMinor!;
	}

	it('detects settlement differences, refunds, unknown money and missing releases', async () => {
		const start = new Date(ctx.clock.now.getTime() + 30_000);
		const settled = await pay();
		const lessNet = await pay();
		const refunded = await pay();
		const missing = await pay();
		const end = new Date(ctx.clock.now.getTime() + 30_000);

		const report = [
			header,
			line(settled.reference, settled.paymentId, 'SETTLEMENT', settled.totalMinor, await net(settled.paymentId), start),
			line(lessNet.reference, lessNet.paymentId, 'SETTLEMENT', lessNet.totalMinor, (await net(lessNet.paymentId)) - 50_000, start),
			line(refunded.reference, refunded.paymentId, 'SETTLEMENT', refunded.totalMinor, await net(refunded.paymentId), start),
			line(refunded.reference, refunded.paymentId, 'REFUND', -refunded.totalMinor, -(await net(refunded.paymentId)), end),
			line('TT-ZZZZZZZZ', '99999999999', 'SETTLEMENT', 100_000, 95_000, end),
			line('POS-VENTA-LOCAL', '99999999998', 'SETTLEMENT', 100_000, 95_000, end)
		].join('\r\n');

		const response = await upload(report);
		expect(response.statusCode, response.body).toBe(200);
		expect(response.json().summary.file).toMatchObject({ rows: 6, inserted: 6 });

		expect(await itemsFor(settled.paymentId)).toEqual([]);
		expect((await itemsFor(lessNet.paymentId)).map((item) => item.kind)).toEqual(['settlement_amount_mismatch']);
		expect((await itemsFor(refunded.paymentId)).map((item) => item.kind)).toEqual(['refund_not_applied']);
		expect((await itemsFor('99999999999')).map((item) => item.kind)).toEqual(['settlement_unmatched']);
		expect(await itemsFor('99999999998')).toEqual([]);
		expect((await itemsFor(missing.paymentId)).map((item) => item.kind)).toEqual(['settlement_missing']);

		// Uploading the same report again stores nothing twice and opens nothing new.
		const again = await upload(report);
		expect(again.json().summary.file).toMatchObject({ inserted: 0 });
		expect(await itemsFor(lessNet.paymentId)).toHaveLength(1);
	});

	it('keeps settlement movements append-only', async () => {
		await expect(
			ctx.db.withTenant(tenant.id, (tx) => tx.update(s.paymentSettlements).set({ netMinor: 1 }).where(eq(s.paymentSettlements.organizationId, tenant.id)))
		).rejects.toThrow();
	});

	it('rejects files that are not the settlement report', async () => {
		const response = await upload('fecha,importe\n2026-10-01,100');
		expect(response.statusCode).toBe(400);
		expect(response.json().error.code).toBe('invalid_report');
	});
});

describe('access, isolation and exports', () => {
	it('applies roles in the API: operators see nothing, owners consult, finance reconciles', async () => {
		const operator = await adminHeaders(ctx, tenant, tenant.operatorId);
		expect((await ctx.app.inject({ method: 'GET', url: '/admin/reconciliation', headers: operator })).statusCode).toBe(403);
		const owner = await adminHeaders(ctx, tenant);
		expect((await ctx.app.inject({ method: 'GET', url: '/admin/reconciliation', headers: owner })).statusCode).toBe(200);
		expect((await ctx.app.inject({ method: 'POST', url: '/admin/reconciliation/runs', headers: owner, payload: {} })).statusCode).toBe(403);
	});

	it('never shows or resolves another organization’s differences', async () => {
		const [item] = await ctx.db.withTenant(tenant.id, (tx) => tx.select().from(s.reconciliationItems).where(eq(s.reconciliationItems.status, 'open')).limit(1));
		const outsider = await finance(other, otherFinanceId);
		const list = await ctx.app.inject({ method: 'GET', url: '/admin/reconciliation/items', headers: outsider });
		expect(list.json().items).toEqual([]);
		const attempt = await ctx.app.inject({
			method: 'POST',
			url: `/admin/reconciliation/items/${item!.id}/resolve`,
			headers: outsider,
			payload: { action: 'accept', note: 'Intento desde otra organización' }
		});
		expect(attempt.statusCode).toBe(404);
	});

	it('exports both sides as CSV without buyer data', async () => {
		const paid = await pay();
		const auth = await finance();
		const from = new Date(ctx.clock.now.getTime() - 86_400_000).toISOString();
		const to = new Date(ctx.clock.now.getTime() + 60_000).toISOString();

		const system = await ctx.app.inject({ method: 'GET', url: `/admin/reconciliation/export/system?from=${from}&to=${to}`, headers: auth });
		expect(system.statusCode).toBe(200);
		expect(system.headers['content-type']).toContain('text/csv');
		expect(system.body).toContain(paid.reference);
		expect(system.body).not.toContain('juana@example.com');

		const provider = await ctx.app.inject({ method: 'GET', url: `/admin/reconciliation/export/provider?from=${from}&to=${to}`, headers: auth });
		expect(provider.body).toContain(paid.paymentId);

		const items = await ctx.app.inject({ method: 'GET', url: `/admin/reconciliation/export/items?from=${from}&to=${to}`, headers: auth });
		expect(items.body.split('\r\n')[0]).toContain('kind,severity,status');

		const tooLong = await ctx.app.inject({ method: 'GET', url: `/admin/reconciliation/export/system?from=2026-01-01&to=2026-10-01`, headers: auth });
		expect(tooLong.statusCode).toBe(400);
	});

	it('runs the scheduled check only with the internal token and only when due', async () => {
		const denied = await ctx.app.inject({ method: 'POST', url: '/internal/reconciliation/run-due', payload: {} });
		expect(denied.statusCode).toBe(401);

		tick(60);
		const internal = { 'x-internal-token': INTERNAL_TOKEN };
		const first = await ctx.app.inject({ method: 'POST', url: '/internal/reconciliation/run-due', headers: internal, payload: { intervalMinutes: 30 } });
		expect(first.statusCode).toBe(200);
		const mine = (body: { results: { organizationId: string; status: string }[] }) => body.results.find((result) => result.organizationId === tenant.id)?.status;
		expect(mine(first.json())).toBe('completed');

		const second = await ctx.app.inject({ method: 'POST', url: '/internal/reconciliation/run-due', headers: internal, payload: { intervalMinutes: 30 } });
		expect(mine(second.json())).toBe('not_due');
		const [run] = await ctx.db.withTenant(tenant.id, (tx) =>
			tx.select().from(s.reconciliationRuns).where(eq(s.reconciliationRuns.trigger, 'scheduled'))
		);
		expect(run).toMatchObject({ status: 'completed', startedBy: null });
	});
});
