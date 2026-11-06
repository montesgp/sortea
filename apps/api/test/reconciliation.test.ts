import { randomUUID } from 'node:crypto';
import { and, eq, schema as s, sql } from '@sortea/db';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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
import { ORDER_ID, ORDER_SEARCH_PAGE_SIZE, type ProviderPayment } from '../src/payments/provider';
import { LATE_APPROVAL_RECHECKS } from '../src/reconciliation/engine';

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
	const payment = ctx.simulator.pay(order.checkoutId, options.outcome ?? 'approved');
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
	it('matches payments that agree, with the fees and net Mercado Pago reports for them (FR-PAY-06)', async () => {
		const paid = await pay();
		const run = await reconcile();
		expect(run.status).toBe('completed');
		expect(run.summary.matched).toBeGreaterThanOrEqual(1);
		expect(await itemsFor(paid.paymentId)).toEqual([]);

		const reported = ctx.simulator.orders.get(paid.paymentId)!.facts;
		const [payment] = await ctx.db.withTenant(tenant.id, (tx) => tx.select().from(s.payments).where(eq(s.payments.providerPaymentId, paid.paymentId)));
		expect(payment).toMatchObject({ feeMinor: reported.feeMinor, netMinor: paid.totalMinor - reported.feeMinor!, releaseDate: reported.releaseDate });
		expect(payment!.feeMinor).toBeGreaterThan(0);

		const overview = await ctx.app.inject({ method: 'GET', url: '/admin/reconciliation', headers: await finance() });
		const body = overview.json();
		expect(body.finance.grossMinor).toBeGreaterThanOrEqual(paid.totalMinor);
		expect(body.finance.feesMinor).toBeGreaterThanOrEqual(reported.feeMinor!);
		expect(body.finance).toMatchObject({ feesUnknown: 0, netUnknown: 0 });
		// Available balance and payouts are never inferred from approved sales.
		expect(body.finance.availableMinor).toBeNull();
		expect(body.runs[0].status).toBe('completed');
	});

	it('a re-read keeps the stored fees when the provider read brings none, and takes a newer release status', async () => {
		const paid = await pay();
		const stored = async () => {
			const [row] = await ctx.db.withTenant(tenant.id, (tx) => tx.select().from(s.payments).where(eq(s.payments.providerPaymentId, paid.paymentId)));
			return row!;
		};
		const before = await stored();
		expect(before.feeMinor).not.toBeNull();

		// The payment read failed this time: the order still reads, without fees.
		ctx.simulator.tamper(paid.paymentId, { feeMinor: null, netMinor: null, releaseDate: null, releaseStatus: null });
		await reconcile();
		expect(await stored()).toMatchObject({ feeMinor: before.feeMinor, netMinor: before.netMinor, releaseDate: before.releaseDate, releaseStatus: before.releaseStatus });
		expect(await itemsFor(paid.paymentId)).toEqual([]);

		const releasedAt = new Date(ctx.clock.now.getTime() + 86_400_000);
		ctx.simulator.tamper(paid.paymentId, { feeMinor: before.feeMinor, netMinor: before.netMinor, releaseDate: releasedAt, releaseStatus: 'released' });
		await reconcile();
		expect(await stored()).toMatchObject({ feeMinor: before.feeMinor, releaseDate: releasedAt, releaseStatus: 'released' });
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

	it('detects a chargeback the platform missed and voids the coupons when applied', async () => {
		const paid = await pay();
		ctx.simulator.setStatus(paid.paymentId, 'charged_back');
		await reconcile();
		const [item] = await itemsFor(paid.paymentId);
		expect(item).toMatchObject({ kind: 'refund_not_applied', severity: 'critical', observed: { status: 'charged_back' } });

		expect((await resolve(item!.id, { action: 'apply_provider_state' })).json()).toEqual({ outcome: 'charged_back', resolved: true });
		const order = await orderByReference(ctx, tenant, paid.reference);
		expect(order.status).toBe('charged_back');
		const entries = await ctx.db.withTenant(tenant.id, (tx) => tx.select().from(s.participationEntries).where(eq(s.participationEntries.orderId, order.id)));
		expect(entries.length).toBeGreaterThan(0);
		expect(entries.every((entry) => entry.status === 'void')).toBe(true);
	});

	it('finds an approval of an order whose Mercado Pago id the platform never stored', async () => {
		tick();
		const order = await placeOrder(ctx, tenant);
		// The order was created at Mercado Pago, but the platform never kept its id.
		await ctx.db.withTenant(tenant.id, (tx) => tx.update(s.orders).set({ providerCheckoutId: null }).where(eq(s.orders.reference, order.reference)));
		ctx.simulator.pay(order.checkoutId, 'approved');
		await reconcile();
		expect(await itemsFor(order.checkoutId)).toEqual([expect.objectContaining({ kind: 'payment_missing_in_system', orderReference: order.reference })]);
	});

	it('reports a paid Mercado Pago order with our reference format that no platform order has', async () => {
		tick();
		const order = await placeOrder(ctx, tenant);
		const { request, accessToken } = ctx.simulator.orders.get(order.checkoutId)!;
		const stray = await ctx.simulator.createCheckout({ accessToken, webhookSecret: tenant.webhookSecret }, { ...request, orderReference: 'TT-ZZZZ9999', idempotencyKey: randomUUID() });
		ctx.simulator.pay(stray.id, 'approved');
		await reconcile();
		expect(await itemsFor(stray.id)).toEqual([expect.objectContaining({ kind: 'unknown_reference', orderReference: 'TT-ZZZZ9999' })]);
	});

	it('re-reads approved orders within the 180-day horizon, and not older ones', async () => {
		const recent = await pay();
		const old = await pay();
		const day = 86_400_000;
		const age = async (reference: string, days: number) => {
			const at = new Date(ctx.clock.now.getTime() - days * day);
			const { checkoutId } = await orderByReference(ctx, tenant, reference).then((row) => ({ checkoutId: row.providerCheckoutId! }));
			ctx.simulator.orders.set(checkoutId, { ...ctx.simulator.orders.get(checkoutId)!, createdAt: at });
			await ctx.db.withTenant(tenant.id, async (tx) => {
				const [row] = await tx.update(s.orders).set({ createdAt: at, expiresAt: new Date(at.getTime() + 3_600_000) }).where(eq(s.orders.reference, reference)).returning();
				await tx.update(s.payments).set({ createdAt: at, approvedAt: at, updatedAt: at }).where(eq(s.payments.orderId, row!.id));
			});
		};
		await age(recent.reference, 179);
		await age(old.reference, 181);
		// Both are refunded at Mercado Pago and both webhooks are lost.
		ctx.simulator.setStatus(recent.paymentId, 'refunded');
		ctx.simulator.setStatus(old.paymentId, 'refunded');
		const reads = vi.spyOn(ctx.simulator, 'getOrder');
		try {
			await reconcile();
			const read = new Set(reads.mock.calls.map(([, id]) => id));
			expect(read.has(recent.paymentId)).toBe(true);
			expect(read.has(old.paymentId)).toBe(false);
		} finally {
			reads.mockRestore();
		}
		expect((await itemsFor(recent.paymentId)).map((item) => item.kind)).toEqual(['refund_not_applied']);
		expect(await itemsFor(old.paymentId)).toEqual([]);
	});

	it('reports partial refunds and payments the provider does not have', async () => {
		const partial = await pay();
		ctx.simulator.refundPartially(partial.paymentId, 200_000);
		const vanished = await pay();
		ctx.simulator.orders.delete(vanished.paymentId);

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

/** A tenant of its own, with an open campaign and a finance manager, so its runs and turns start from zero. */
async function financeTenant(label: string) {
	const target = await createTenant(ctx, label);
	await openCampaign(ctx, target);
	const userId = randomUUID();
	await addMember(target, userId, 'finance_manager');
	return { tenant: target, financeId: userId };
}

async function openItems(target: TenantFixture, paymentId: string) {
	return ctx.db.withTenant(target.id, (tx) =>
		tx
			.select()
			.from(s.reconciliationItems)
			.where(and(eq(s.reconciliationItems.providerPaymentId, paymentId), eq(s.reconciliationItems.status, 'open')))
	);
}

/** Moves an order (and its Mercado Pago order) back in time, so it is outside every later window. */
async function backdate(target: TenantFixture, checkoutId: string, days: number) {
	const at = new Date(ctx.clock.now.getTime() - days * 86_400_000);
	const simulated = ctx.simulator.orders.get(checkoutId);
	if (simulated) ctx.simulator.orders.set(checkoutId, { ...simulated, createdAt: at });
	await ctx.db.withTenant(target.id, async (tx) => {
		const [row] = await tx.update(s.orders).set({ createdAt: at, expiresAt: new Date(at.getTime() + 3_600_000) }).where(eq(s.orders.providerCheckoutId, checkoutId)).returning();
		await tx.update(s.payments).set({ createdAt: at, approvedAt: at, updatedAt: at }).where(eq(s.payments.orderId, row!.id));
	});
}

async function readsDuring(run: () => Promise<unknown>): Promise<string[]> {
	const reads = vi.spyOn(ctx.simulator, 'getOrder');
	try {
		await run();
		return reads.mock.calls.map(([, id]) => id);
	} finally {
		reads.mockRestore();
	}
}

describe('late approvals and payments stored before the Orders API (S3, S4)', () => {
	it('a late approval of an order whose notifications were all lost is found (S3)', async () => {
		const { tenant, financeId } = await financeTenant('probe-late-b');
		await reconcile(tenant, financeId);
		const order = await placeOrder(ctx, tenant);
		ctx.simulator.pay(order.checkoutId, 'in_process');
		for (let run = 0; run < 4; run++) {
			tick(30);
			await reconcile(tenant, financeId);
		}
		tick(24 * 60);
		ctx.simulator.setStatus(order.checkoutId, 'approved');
		await reconcile(tenant, financeId);
		expect((await openItems(tenant, order.checkoutId)).map((item) => item.kind)).toEqual(['payment_missing_in_system']);
	});

	it('re-reads unpaid orders created within the 7-day late-approval horizon, and not older ones (S3)', async () => {
		const { tenant, financeId } = await financeTenant('late-horizon');
		await reconcile(tenant, financeId);
		const recent = await placeOrder(ctx, tenant);
		const old = await placeOrder(ctx, tenant);
		await backdate(tenant, recent.checkoutId, 6);
		await backdate(tenant, old.checkoutId, 8);
		// Both are approved at Mercado Pago and every webhook is lost.
		ctx.simulator.pay(recent.checkoutId, 'approved');
		ctx.simulator.pay(old.checkoutId, 'approved');
		const read = await readsDuring(() => reconcile(tenant, financeId));
		expect(read).toContain(recent.checkoutId);
		expect(read).not.toContain(old.checkoutId);
		expect((await openItems(tenant, recent.checkoutId)).map((item) => item.kind)).toEqual(['payment_missing_in_system']);
		expect(await openItems(tenant, old.checkoutId)).toEqual([]);
	});

	it('unpaid orders have a budget of their own and never starve open items or approved payments (S3)', async () => {
		const { tenant, financeId } = await financeTenant('late-budget');
		const paid = async () => {
			const order = await placeOrder(ctx, tenant);
			await ctx.app.inject(webhookRequest(tenant, ctx.simulator.pay(order.checkoutId, 'approved').id));
			return order.checkoutId;
		};
		const vanished = await paid();
		const approved = await paid();
		ctx.simulator.orders.delete(vanished);
		await reconcile(tenant, financeId);
		expect((await openItems(tenant, vanished)).map((item) => item.kind)).toEqual(['payment_missing_at_provider']);
		// The approved payment is outside the window: only its turn re-reads it.
		await backdate(tenant, approved, 3);

		// More unpaid orders within the horizon than their budget.
		const source = await placeOrder(ctx, tenant);
		await backdate(tenant, source.checkoutId, 2);
		const late = new Set([source.checkoutId]);
		await ctx.db.withTenant(tenant.id, async (tx) => {
			const [row] = await tx.select().from(s.orders).where(eq(s.orders.providerCheckoutId, source.checkoutId));
			const copies = Array.from({ length: LATE_APPROVAL_RECHECKS + 50 }, (_, index) => ({
				...row!,
				id: randomUUID(),
				reference: `TT-LATE${String(index).padStart(4, '0')}`,
				providerCheckoutId: `ORDLATE${String(index).padStart(4, '0')}`,
				status: 'expired' as const,
				reservedEntries: 0
			}));
			await tx.insert(s.orders).values(copies);
			for (const copy of copies) late.add(copy.providerCheckoutId);
		});

		const first = await readsDuring(() => reconcile(tenant, financeId));
		expect(first).toContain(vanished);
		expect(first).toContain(approved);
		expect(first.filter((id) => late.has(id))).toHaveLength(LATE_APPROVAL_RECHECKS);
		// The next run takes the next turn, so every unpaid order is re-read within two runs.
		const second = await readsDuring(() => reconcile(tenant, financeId));
		expect(second).toContain(vanished);
		expect(new Set([...first, ...second].filter((id) => late.has(id)))).toEqual(late);
		expect((await openItems(tenant, vanished)).map((item) => item.kind)).toEqual(['payment_missing_at_provider']);
	});

	it('a cash payment credited on day 6 of an expired order whose notifications were lost is found (S3)', async () => {
		const { tenant, financeId } = await financeTenant('late-day6');
		await reconcile(tenant, financeId);
		const order = await placeOrder(ctx, tenant);
		ctx.simulator.pay(order.checkoutId, 'in_process');
		await backdate(tenant, order.checkoutId, 6);
		await ctx.db.withTenant(tenant.id, (tx) => tx.update(s.orders).set({ status: 'expired' }).where(eq(s.orders.providerCheckoutId, order.checkoutId)));
		await reconcile(tenant, financeId);
		ctx.simulator.setStatus(order.checkoutId, 'approved');
		await reconcile(tenant, financeId);
		expect((await openItems(tenant, order.checkoutId)).map((item) => item.kind)).toEqual(['payment_missing_in_system']);
	});

	it('the late-approval horizon ends at 7 days (S3)', async () => {
		const { tenant, financeId } = await financeTenant('late-edge');
		await reconcile(tenant, financeId);
		const inside = await placeOrder(ctx, tenant);
		const outside = await placeOrder(ctx, tenant);
		await backdate(tenant, inside.checkoutId, 7 - 5 / 1440);
		await backdate(tenant, outside.checkoutId, 7 + 5 / 1440);
		ctx.simulator.pay(inside.checkoutId, 'approved');
		ctx.simulator.pay(outside.checkoutId, 'approved');
		const read = await readsDuring(() => reconcile(tenant, financeId));
		expect(read).toContain(inside.checkoutId);
		expect(read).not.toContain(outside.checkoutId);
	});

	it('a rejected order approved 30 hours later with the webhook lost is reported (S3)', async () => {
		const { tenant, financeId } = await financeTenant('late-failed');
		await reconcile(tenant, financeId);
		const order = await placeOrder(ctx, tenant);
		expect((await ctx.app.inject(webhookRequest(tenant, ctx.simulator.pay(order.checkoutId, 'rejected').id))).statusCode).toBe(200);
		expect((await orderByReference(ctx, tenant, order.reference)).status).toBe('payment_failed');
		for (let run = 0; run < 4; run++) {
			tick(30);
			await reconcile(tenant, financeId);
		}
		tick(30 * 60);
		ctx.simulator.setStatus(order.checkoutId, 'approved');
		await reconcile(tenant, financeId);
		expect((await openItems(tenant, order.checkoutId)).map((item) => item.kind)).toEqual(['status_mismatch']);
	});

	it('clears only missing-at-provider items of non-order ids, and only in the running organization (S4)', async () => {
		const a = await financeTenant('legacy-scope-a');
		const b = await financeTenant('legacy-scope-b');
		const runA = await reconcile(a.tenant, a.financeId);
		const runB = await reconcile(b.tenant, b.financeId);
		const item = (organizationId: string, runId: string, kind: 'payment_missing_at_provider' | 'status_mismatch', id: string) => ({
			organizationId, firstRunId: runId, lastRunId: runId, kind, severity: 'critical' as const, fingerprint: `${kind}:${id}`,
			providerPaymentId: id, orderReference: null, orderId: null, expected: {}, observed: {}
		});
		await ctx.db.withTenant(a.tenant.id, (tx) =>
			tx.insert(s.reconciliationItems).values([item(a.tenant.id, runA.runId, 'payment_missing_at_provider', '111'), item(a.tenant.id, runA.runId, 'status_mismatch', '222')])
		);
		await ctx.db.withTenant(b.tenant.id, (tx) => tx.insert(s.reconciliationItems).values([item(b.tenant.id, runB.runId, 'payment_missing_at_provider', '333')]));
		await reconcile(a.tenant, a.financeId);
		expect(await openItems(a.tenant, '111')).toEqual([]);
		expect((await openItems(a.tenant, '222')).map((open) => open.kind)).toEqual(['status_mismatch']);
		expect((await openItems(b.tenant, '333')).map((open) => open.kind)).toEqual(['payment_missing_at_provider']);
	});

	it('Postgres reads order ids like the adapter (S4)', async () => {
		const ids = ['ORDSIM0123456789ABCDEF01234567', 'ORD01JQ8ZK3W4X5Y6Z7A8B9C0D1E', 'ORDTST01JQ8ZK3W4X5Y6Z7A8B9C0D1E', '1234567890', '123456789-0a1b2c3d-4e5f-6789-abcd-ef0123456789', 'ord01abc', 'ORD', 'ORD_1', 'ORD12\n', 'ORD' + 'A'.repeat(61)];
		const matches: boolean[] = [];
		for (const id of ids) {
			const [row] = await ctx.db.withPlatform((db) => db.select({ match: sql<boolean>`${id} ~ ${ORDER_ID.source}` }).from(s.organizations).limit(1));
			matches.push(row!.match);
		}
		expect(matches).toEqual(ids.map((id) => ORDER_ID.test(id)));
	});

	it('keeps payments stored before the Orders API as history: never re-read, and their missing-at-provider items close (S4)', async () => {
		const { tenant, financeId } = await financeTenant('legacy');
		const order = await placeOrder(ctx, tenant);
		await ctx.app.inject(webhookRequest(tenant, ctx.simulator.pay(order.checkoutId, 'approved').id));
		const vanished = await placeOrder(ctx, tenant);
		await ctx.app.inject(webhookRequest(tenant, ctx.simulator.pay(vanished.checkoutId, 'approved').id));
		ctx.simulator.orders.delete(vanished.checkoutId);
		// A Preferences API payment: a numeric payment id, and the preference id on the order.
		const legacyId = '1234567890';
		const preferenceId = '123456789-0a1b2c3d-4e5f-6789-abcd-ef0123456789';
		const row = await orderByReference(ctx, tenant, order.reference);
		await ctx.db.withTenant(tenant.id, async (tx) => {
			await tx.update(s.orders).set({ providerCheckoutId: preferenceId }).where(eq(s.orders.id, row.id));
			await tx.update(s.payments).set({ providerPaymentId: legacyId }).where(eq(s.payments.orderId, row.id));
		});
		// The item the earlier code raised for it.
		const before = await reconcile(tenant, financeId);
		await ctx.db.withTenant(tenant.id, (tx) =>
			tx.insert(s.reconciliationItems).values({
				organizationId: tenant.id,
				firstRunId: before.runId,
				lastRunId: before.runId,
				kind: 'payment_missing_at_provider',
				severity: 'critical',
				fingerprint: `payment_missing_at_provider:${legacyId}`,
				providerPaymentId: legacyId,
				orderReference: order.reference,
				orderId: row.id,
				expected: { status: 'approved' },
				observed: { status: null }
			}).onConflictDoNothing()
		);

		const read = await readsDuring(() => reconcile(tenant, financeId));
		expect(read).not.toContain(legacyId);
		expect(read).not.toContain(preferenceId);
		expect(await openItems(tenant, legacyId)).toEqual([]);
		const [closed] = await ctx.db.withTenant(tenant.id, (tx) =>
			tx.select().from(s.reconciliationItems).where(eq(s.reconciliationItems.providerPaymentId, legacyId))
		);
		expect(closed).toMatchObject({ status: 'resolved', resolution: 'cleared', resolvedBy: null });
		expect(closed!.resolutionNote).toContain('anterior a la API de órdenes');
		// The payment and the order stay as they were; an order payment Mercado Pago lost still reports.
		const [payment] = await ctx.db.withTenant(tenant.id, (tx) => tx.select().from(s.payments).where(eq(s.payments.providerPaymentId, legacyId)));
		expect(payment).toMatchObject({ status: 'approved' });
		expect((await orderByReference(ctx, tenant, order.reference)).status).toBe('paid');
		expect((await openItems(tenant, vanished.checkoutId)).map((item) => item.kind)).toEqual(['payment_missing_at_provider']);
	});
});

describe('orders search paging', () => {
	/** A provider that ignores `offset` and states no total: every page is the same full page, counted one more (as the adapter does). */
	async function withLoopingSearch<T>(run: () => Promise<T>) {
		const page: ProviderPayment[] = Array.from({ length: ORDER_SEARCH_PAGE_SIZE }, (_, index) => ({
			id: `ORDLOOP${String(index).padStart(4, '0')}`,
			status: 'processed',
			statusDetail: 'accredited',
			externalReference: null,
			amountMinor: 1_000,
			currency: 'ARS',
			collectorId: null,
			approvedAt: null,
			refundedMinor: 0,
			feeMinor: null,
			netMinor: null,
			releaseDate: null,
			releaseStatus: null,
			updatedAt: null,
			attempts: 1
		}));
		const calls: { createdFrom: string; offset: number }[] = [];
		const search = vi.spyOn(ctx.simulator, 'searchOrders').mockImplementation(async (_credentials, query) => {
			calls.push({ createdFrom: query.createdFrom.toISOString(), offset: query.offset });
			// Without a guard the caller would page forever; fail instead of hanging the suite.
			if (calls.length > 1_000) throw new Error('searchOrders paged forever');
			return { results: page, total: query.offset + page.length + 1 };
		});
		try {
			return { result: await run(), calls, ids: page.map((order) => order.id) };
		} finally {
			search.mockRestore();
		}
	}

	it('a run stops when a page brings no new order, and examines each order once', async () => {
		const { tenant, financeId } = await financeTenant('paging-loop');
		const { result, calls } = await withLoopingSearch(() => reconcile(tenant, financeId));
		expect(result.summary.examined).toBe(ORDER_SEARCH_PAGE_SIZE);
		// Each search (one per day of creation dates) asks the first page and one more, which brings nothing new.
		const searches = new Map<string, number[]>();
		for (const call of calls) searches.set(call.createdFrom, [...(searches.get(call.createdFrom) ?? []), call.offset]);
		expect(searches.size).toBeGreaterThan(0);
		for (const offsets of searches.values()) expect(offsets).toEqual([0, ORDER_SEARCH_PAGE_SIZE]);
	});

	it('the provider export stops too, and lists each order once', async () => {
		const { tenant, financeId } = await financeTenant('paging-export');
		const from = new Date(ctx.clock.now.getTime() - 86_400_000).toISOString();
		const to = ctx.clock.now.toISOString();
		const auth = await finance(tenant, financeId);
		const { result, calls, ids } = await withLoopingSearch(() =>
			ctx.app.inject({ method: 'GET', url: `/admin/reconciliation/export/provider?from=${from}&to=${to}`, headers: auth })
		);
		expect(result.statusCode, result.body).toBe(200);
		expect(calls.map((call) => call.offset)).toEqual([0, ORDER_SEARCH_PAGE_SIZE]);
		for (const id of ids) expect(result.body.split(id)).toHaveLength(2);
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

	/** The report names a payment by Mercado Pago's numeric id, not the order id: movements are matched by reference. */
	let sourceSequence = 70_000_000_000;
	const sourceId = () => String(sourceSequence++);
	const netOf = (grossMinor: number) => grossMinor - Math.round((grossMinor * 629) / 10_000);

	it('detects settlement differences, refunds and unknown money, matching movements by reference', async () => {
		const start = new Date(ctx.clock.now.getTime() + 30_000);
		const settled = await pay();
		const lessGross = await pay();
		const refunded = await pay();
		const missing = await pay();
		const lessNet = await pay();
		const end = new Date(ctx.clock.now.getTime() + 30_000);
		const [settledSource, lessSource, refundedSource, lessNetSource] = [sourceId(), sourceId(), sourceId(), sourceId()];

		const report = [
			header,
			line(settled.reference, settledSource, 'SETTLEMENT', settled.totalMinor, netOf(settled.totalMinor), start),
			line(lessGross.reference, lessSource, 'SETTLEMENT', lessGross.totalMinor - 50_000, netOf(lessGross.totalMinor - 50_000), start),
			line(refunded.reference, refundedSource, 'SETTLEMENT', refunded.totalMinor, netOf(refunded.totalMinor), start),
			line(refunded.reference, refundedSource, 'REFUND', -refunded.totalMinor, -netOf(refunded.totalMinor), end),
			line(lessNet.reference, lessNetSource, 'SETTLEMENT', lessNet.totalMinor, netOf(lessNet.totalMinor) - 1_000, start),
			line('TT-ZZZZZZZZ', '99999999999', 'SETTLEMENT', 100_000, 95_000, end),
			line('POS-VENTA-LOCAL', '99999999998', 'SETTLEMENT', 100_000, 95_000, end)
		].join('\r\n');

		const response = await upload(report);
		expect(response.statusCode, response.body).toBe(200);
		expect(response.json().summary.file).toMatchObject({ rows: 7, inserted: 7 });

		expect(await itemsFor(settled.paymentId)).toEqual([]);
		expect((await itemsFor(lessGross.paymentId)).map((item) => item.kind)).toEqual(['settlement_amount_mismatch']);
		expect((await itemsFor(refunded.paymentId)).map((item) => item.kind)).toEqual(['refund_not_applied']);
		expect((await itemsFor('99999999999')).map((item) => item.kind)).toEqual(['settlement_unmatched']);
		expect(await itemsFor('99999999998')).toEqual([]);
		// The net Mercado Pago reported for the payment differs from what the report settles.
		const [netItem, ...others] = await itemsFor(lessNet.paymentId);
		expect(others).toEqual([]);
		expect(netItem).toMatchObject({
			kind: 'settlement_amount_mismatch',
			severity: 'warning',
			expected: { grossMinor: lessNet.totalMinor, netMinor: netOf(lessNet.totalMinor) },
			observed: { netMinor: netOf(lessNet.totalMinor) - 1_000 }
		});
		// The payment's release date falls in the report's period, so its sale is expected in it.
		const released = ctx.simulator.orders.get(missing.paymentId)!.facts.releaseDate!;
		expect((await itemsFor(missing.paymentId)).map((item) => [item.kind, item.severity, item.expected])).toEqual([
			['settlement_missing', 'warning', { grossMinor: missing.totalMinor, releaseDate: released.toISOString() }]
		]);

		// Uploading the same report again stores nothing twice and opens nothing new.
		const again = await upload(report);
		expect(again.json().summary.file).toMatchObject({ inserted: 0 });
		expect(await itemsFor(lessGross.paymentId)).toHaveLength(1);
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

	it('raises open critical differences as a dashboard alert', async () => {
		const overview = await ctx.app.inject({ method: 'GET', url: '/admin/overview', headers: await finance() });
		const alert = overview.json().alerts.find((candidate: { kind: string }) => candidate.kind === 'reconciliation');
		expect(alert.count).toBeGreaterThan(0);
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
