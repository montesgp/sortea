import { randomUUID } from 'node:crypto';
import { and, asc, eq, gt, schema as s } from '@sortea/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminHeaders, createTenant, createTestContext, openCampaign, orderByReference, placeOrder, webhookRequest, type TenantFixture, type TestContext } from './helpers';

/**
 * Campaign finance (odd/tasks/campaign-finance.md S1, S2, S4, S5, S6; ADR 0025): the overview
 * for the whole organization or one campaign, the expenses charged to a campaign, and the
 * campaign balance: sales − refunds − Mercado Pago fees − prizes − expenses.
 */
let ctx: TestContext;
let tenant: TenantFixture;
let other: TenantFixture;
const financeId = randomUUID();
const auditorId = randomUUID();
const supportId = randomUUID();
const campaigns = { fulfilled: randomUUID(), archived: randomUUID(), archivedClosed: randomUUID() };
/** Two manuals: 2 × 1.200.000 centavos; the simulator reports Mercado Pago's 6,29 % fee. */
const ORDER_MINOR = 2_400_000;
const FEE_MINOR = 150_960;
const FIXTURE_PRIZES_MINOR = 800_000_000 + 10 * 10_000_000 + 5 * 5_000_000;
let shopReference: string;

interface Expense {
	id: string;
	category: string;
	detail: string;
	amountMinor: number;
	currency: string;
	spentOn: string;
}

interface Balance {
	salesMinor: number;
	refundsMinor: number;
	feesMinor: number;
	feesPendingPayments: number;
	prizesCommittedMinor: number;
	prizesDeliveredMinor: number;
	expensesByCategory: { category: string; totalMinor: number }[];
	expensesMinor: number;
	resultMinor: number;
	final: boolean;
}

const expensesUrl = (campaignId: string, expenseId?: string) => `/admin/campaigns/${campaignId}/expenses${expenseId ? `/${expenseId}` : ''}`;

async function addMember(target: TenantFixture, userId: string, role: 'finance_manager' | 'auditor' | 'support_agent') {
	await ctx.db.withPlatform((db) => db.insert(s.organizationMembers).values({ organizationId: target.id, userId, email: `${role}@${target.host}`, role }));
}

async function paidOrder(target: TenantFixture, overrides: Record<string, unknown> = {}) {
	ctx.clock.now = new Date(ctx.clock.now.getTime() + 60_000);
	const order = await placeOrder(ctx, target, overrides);
	const payment = ctx.simulator.pay(order.checkoutId, 'approved');
	expect((await ctx.app.inject(webhookRequest(target, payment.id))).statusCode).toBe(200);
	return { reference: order.reference, paymentId: payment.id };
}

async function overview(target = tenant, campaignId?: string, userId = target.ownerId) {
	const response = await ctx.app.inject({ method: 'GET', url: `/admin/overview${campaignId ? `?campaign=${campaignId}` : ''}`, headers: await adminHeaders(ctx, target, userId) });
	expect(response.statusCode, response.body).toBe(200);
	return response.json();
}

async function createExpense(campaignId: string, body: Record<string, unknown>, target = tenant, userId = target.ownerId) {
	return ctx.app.inject({ method: 'POST', url: expensesUrl(campaignId), headers: await adminHeaders(ctx, target, userId), payload: body });
}

async function newExpense(campaignId: string, body: Record<string, unknown>, target = tenant, userId = target.ownerId): Promise<Expense> {
	const response = await createExpense(campaignId, body, target, userId);
	expect(response.statusCode, response.body).toBe(201);
	return response.json().expense as Expense;
}

async function listExpenses(campaignId: string, target = tenant, userId = target.ownerId) {
	return ctx.app.inject({ method: 'GET', url: expensesUrl(campaignId), headers: await adminHeaders(ctx, target, userId) });
}

async function auditOf(action: string, expenseId: string) {
	const rows = await ctx.db.withTenant(tenant.id, (tx) => tx.select().from(s.auditEvents).where(eq(s.auditEvents.action, action)).orderBy(asc(s.auditEvents.createdAt)));
	return rows.filter((row) => row.metadata.expenseId === expenseId);
}

/** A campaign of the tenant in a later state, with its prizes; an archived one may have published its manifest. */
async function insertCampaign(id: string, status: 'fulfilled' | 'archived', prizes: { value: number; quantity: number }, manifest: boolean) {
	await ctx.db.withPlatform(async (db) => {
		await db.insert(s.campaigns).values({
			id,
			organizationId: tenant.id,
			slug: `c-${id.slice(0, 8)}`,
			title: `Campaña ${status} ${id.slice(0, 4)}`,
			summary: 'Campaña anterior',
			status,
			timezone: 'America/Argentina/Buenos_Aires',
			opensAt: new Date('2026-08-01T00:00:00Z'),
			closesAt: new Date('2026-09-01T00:00:00Z')
		});
		await db.insert(s.prizes).values({ organizationId: tenant.id, campaignId: id, position: 1, kind: 'product', title: 'Premio', declaredValueMinor: prizes.value, quantity: prizes.quantity });
		if (manifest) {
			await db.insert(s.drawManifests).values({
				organizationId: tenant.id,
				campaignId: id,
				ruleVersion: 1,
				sha256: 'a'.repeat(64),
				content: '{}',
				eligibleCount: 0,
				voidCount: 0,
				closedAt: new Date('2026-09-01T00:00:00Z'),
				publishedAt: new Date('2026-09-01T00:05:00Z')
			});
		}
	});
}

beforeAll(async () => {
	ctx = await createTestContext();
	tenant = await createTenant(ctx, 'finance');
	other = await createTenant(ctx, 'finance-other');
	await addMember(tenant, financeId, 'finance_manager');
	await addMember(tenant, auditorId, 'auditor');
	await addMember(tenant, supportId, 'support_agent');

	// Bought from the shop before any campaign opened: an order without a campaign.
	shopReference = (await paidOrder(tenant, { campaignSlug: undefined })).reference;
	await openCampaign(ctx, tenant);
	await openCampaign(ctx, other);

	await paidOrder(tenant);
	// Mercado Pago has not reported this payment's fee yet.
	const pendingFee = await paidOrder(tenant);
	const pendingOrder = await orderByReference(ctx, tenant, pendingFee.reference);
	await ctx.db.withPlatform((db) => db.update(s.payments).set({ feeMinor: null, netMinor: null }).where(eq(s.payments.orderId, pendingOrder.id)));
	// Paid, then refunded in full.
	const refunded = await paidOrder(tenant);
	ctx.simulator.setStatus(refunded.paymentId, 'refunded');
	expect((await ctx.app.inject(webhookRequest(tenant, refunded.paymentId))).statusCode).toBe(200);
	await paidOrder(other);

	await insertCampaign(campaigns.fulfilled, 'fulfilled', { value: 1_000_000, quantity: 1 }, false);
	await insertCampaign(campaigns.archived, 'archived', { value: 7_000_000, quantity: 1 }, false);
	await insertCampaign(campaigns.archivedClosed, 'archived', { value: 50_000, quantity: 2 }, true);

	await newExpense(tenant.campaignId, { category: 'tecnologia', detail: 'Hosting y servicios', amountMinor: 1_500_000, spentOn: '2026-10-01' });
	await newExpense(tenant.campaignId, { category: 'repuestos', detail: 'Carburador', amountMinor: 4_500_000, spentOn: '2026-10-03' }, tenant, financeId);
	await newExpense(tenant.campaignId, { category: 'combustible', detail: 'Nafta para buscar la moto', amountMinor: 300_000, spentOn: '2026-10-02' });
	await newExpense(campaigns.fulfilled, { category: 'mano_de_obra', detail: 'Pintura', amountMinor: 2_000_000, spentOn: '2026-08-20' });
	// The recount happens at the end: an archived campaign still takes expenses.
	await newExpense(campaigns.archived, { category: 'dominio', detail: 'Dominio anual', amountMinor: 100_000, spentOn: '2026-08-02' });
	await newExpense(other.campaignId, { category: 'publicidad', detail: 'Anuncios', amountMinor: 9_999_900, spentOn: '2026-10-05' }, other);
});
afterAll(() => ctx.close());

describe('campaign-scoped overview (S1, S5)', () => {
	it('scopes every number to the campaign and adds fees, pending fees and expenses', async () => {
		const scoped = await overview(tenant, tenant.campaignId);
		expect(scoped.scope).toEqual({ campaign: { id: tenant.campaignId, title: 'Moto 0 km', status: 'open' } });
		expect(scoped.kpis).toMatchObject({
			grossApprovedMinor: 2 * ORDER_MINOR,
			paidOrders: 2,
			pendingOrders: 0,
			refundedMinor: ORDER_MINOR,
			participants: 1,
			entries: 4,
			prizesCommittedMinor: FIXTURE_PRIZES_MINOR,
			prizesDeliveredMinor: 0,
			feesMinor: FEE_MINOR,
			feesPendingPayments: 1,
			expensesMinor: 6_300_000
		});
		// Sales count every charged order (the refunded one too), so its refund takes it back once.
		const result = 3 * ORDER_MINOR - ORDER_MINOR - FEE_MINOR - FIXTURE_PRIZES_MINOR - 6_300_000;
		expect(scoped.kpis.projectedNetMinor).toBe(result);
		expect(scoped.daily.reduce((total: number, day: { totalMinor: number }) => total + day.totalMinor, 0)).toBe(2 * ORDER_MINOR);
		expect(scoped.recent.map((order: { reference: string }) => order.reference)).not.toContain(shopReference);
		expect(scoped.recent).toHaveLength(3);
	});

	it('returns the campaign balance, with expenses grouped by category in the list order, projected while it sells', async () => {
		const { balance } = (await overview(tenant, tenant.campaignId)) as { balance: Balance };
		expect(balance).toEqual({
			salesMinor: 3 * ORDER_MINOR,
			refundsMinor: ORDER_MINOR,
			feesMinor: FEE_MINOR,
			feesPendingPayments: 1,
			prizesCommittedMinor: FIXTURE_PRIZES_MINOR,
			prizesDeliveredMinor: 0,
			expensesByCategory: [
				{ category: 'tecnologia', totalMinor: 1_500_000 },
				{ category: 'repuestos', totalMinor: 4_500_000 },
				{ category: 'combustible', totalMinor: 300_000 }
			],
			expensesMinor: 6_300_000,
			resultMinor: 3 * ORDER_MINOR - ORDER_MINOR - FEE_MINOR - FIXTURE_PRIZES_MINOR - 6_300_000,
			final: false
		});
	});

	it('is final once the campaign closed, and counts the prizes of a campaign that opened', async () => {
		const fulfilled = ((await overview(tenant, campaigns.fulfilled)) as { balance: Balance }).balance;
		expect(fulfilled).toMatchObject({ salesMinor: 0, prizesCommittedMinor: 1_000_000, expensesMinor: 2_000_000, resultMinor: -3_000_000, final: true });
		expect(fulfilled.expensesByCategory).toEqual([{ category: 'mano_de_obra', totalMinor: 2_000_000 }]);
		// Archived before opening: no manifest, so its prizes were never a cost.
		const archived = ((await overview(tenant, campaigns.archived)) as { balance: Balance }).balance;
		expect(archived).toMatchObject({ prizesCommittedMinor: 0, expensesMinor: 100_000, resultMinor: -100_000, final: true });
		const archivedClosed = ((await overview(tenant, campaigns.archivedClosed)) as { balance: Balance }).balance;
		expect(archivedClosed).toMatchObject({ prizesCommittedMinor: 100_000, expensesMinor: 0, resultMinor: -100_000, final: true });
	});

	it('refuses a malformed campaign id and answers 404 for another organization’s campaign', async () => {
		const auth = await adminHeaders(ctx, tenant);
		const malformed = await ctx.app.inject({ method: 'GET', url: '/admin/overview?campaign=moto', headers: auth });
		expect(malformed.statusCode).toBe(400);
		expect(malformed.json().error).toMatchObject({ code: 'invalid_request', details: { fieldErrors: { campaign: ['Elegí una campaña de la lista'] } } });
		const foreign = await ctx.app.inject({ method: 'GET', url: `/admin/overview?campaign=${other.campaignId}`, headers: auth });
		expect(foreign.statusCode).toBe(404);
		expect(foreign.json().error).toEqual({ code: 'not_found', message: 'Campaña no encontrado' });
	});
});

describe('organization-wide overview (S1, S4, S5)', () => {
	it('adds every campaign, the orders without a campaign, and never another organization', async () => {
		const general = await overview();
		expect(general.scope).toEqual({ campaign: null });
		expect(general.balance).toBeNull();
		expect(general.kpis).toMatchObject({
			grossApprovedMinor: 3 * ORDER_MINOR,
			paidOrders: 3,
			refundedMinor: ORDER_MINOR,
			feesMinor: 2 * FEE_MINOR,
			feesPendingPayments: 1,
			expensesMinor: 6_300_000 + 2_000_000 + 100_000,
			prizesCommittedMinor: FIXTURE_PRIZES_MINOR + 1_000_000 + 100_000
		});
		expect(general.kpis.projectedNetMinor).toBe(4 * ORDER_MINOR - ORDER_MINOR - 2 * FEE_MINOR - (FIXTURE_PRIZES_MINOR + 1_100_000) - 8_400_000);
		expect(general.recent.map((order: { reference: string }) => order.reference)).toContain(shopReference);
	});

	it('lists the organization’s campaigns for the selector, and only them', async () => {
		const { campaigns: listed } = (await overview()) as { campaigns: { id: string; title: string; status: string }[] };
		expect(listed.map((campaign) => campaign.id).sort()).toEqual([tenant.campaignId, campaigns.fulfilled, campaigns.archived, campaigns.archivedClosed].sort());
		expect(listed.find((campaign) => campaign.id === tenant.campaignId)).toEqual({ id: tenant.campaignId, title: 'Moto 0 km', status: 'open' });
	});

	it('equals the sum of the campaign results plus the orders without a campaign', async () => {
		const general = await overview();
		let sum = 0;
		for (const campaign of general.campaigns as { id: string }[]) sum += ((await overview(tenant, campaign.id)) as { balance: Balance }).balance.resultMinor;
		expect(general.kpis.projectedNetMinor).toBe(sum + ORDER_MINOR - FEE_MINOR);
	});

	it('nets a paid order refunded in full to zero: the refund is subtracted once', async () => {
		const before = (await overview(tenant, tenant.campaignId)).kpis;
		const order = await paidOrder(tenant);
		const paid = (await overview(tenant, tenant.campaignId)).kpis;
		expect(paid.projectedNetMinor).toBe(before.projectedNetMinor + ORDER_MINOR - FEE_MINOR);
		ctx.simulator.setStatus(order.paymentId, 'refunded');
		expect((await ctx.app.inject(webhookRequest(tenant, order.paymentId))).statusCode).toBe(200);
		const refunded = (await overview(tenant, tenant.campaignId)).kpis;
		expect(refunded.refundedMinor).toBe(before.refundedMinor + ORDER_MINOR);
		expect(refunded.grossApprovedMinor).toBe(before.grossApprovedMinor);
		expect(refunded.projectedNetMinor).toBe(before.projectedNetMinor);
	});

	// A chargeback takes the money back but Mercado Pago keeps its fee: the fee stays a cost (verify advisory 1).
	it('keeps the fee of a charged-back payment as a cost', async () => {
		const before = (await overview(tenant, tenant.campaignId)).kpis;
		const order = await paidOrder(tenant);
		ctx.simulator.setStatus(order.paymentId, 'charged_back');
		expect((await ctx.app.inject(webhookRequest(tenant, order.paymentId))).statusCode).toBe(200);
		const after = (await overview(tenant, tenant.campaignId)).kpis;
		expect(after.feesMinor).toBe(before.feesMinor + FEE_MINOR);
		expect(after.projectedNetMinor).toBe(before.projectedNetMinor - FEE_MINOR);
	});

	// An order with two approved payments counts its sale once and both fees.
	it('counts an order with two approved payments once, with both fees', async () => {
		const before = (await overview(tenant, tenant.campaignId)).kpis;
		const order = await orderByReference(ctx, tenant, (await paidOrder(tenant)).reference);
		await ctx.db.withPlatform((db) =>
			db.insert(s.payments).values({ organizationId: tenant.id, orderId: order.id, provider: 'mercadopago', providerPaymentId: `second-${order.id}`, status: 'approved', amountMinor: ORDER_MINOR, currency: 'ARS', feeMinor: 1_234, netMinor: ORDER_MINOR - 1_234 })
		);
		const after = (await overview(tenant, tenant.campaignId)).kpis;
		expect(after.grossApprovedMinor).toBe(before.grossApprovedMinor + ORDER_MINOR);
		expect(after.feesMinor).toBe(before.feesMinor + FEE_MINOR + 1_234);
	});
});

describe('campaign expenses (S2, S4, S6)', () => {
	it('lists a campaign’s expenses, newest day first, to everyone who sees the overview', async () => {
		for (const userId of [tenant.ownerId, financeId, auditorId, tenant.operatorId]) {
			const response = await listExpenses(tenant.campaignId, tenant, userId);
			expect(response.statusCode, response.body).toBe(200);
			const body = response.json() as { campaign: { id: string }; expenses: Expense[]; totalMinor: number };
			expect(body.campaign).toEqual({ id: tenant.campaignId, title: 'Moto 0 km', status: 'open' });
			expect(body.expenses.map((expense) => expense.spentOn)).toEqual(['2026-10-03', '2026-10-02', '2026-10-01']);
			expect(body.expenses[0]).toMatchObject({ category: 'repuestos', detail: 'Carburador', amountMinor: 4_500_000, currency: 'ARS' });
			expect(body.totalMinor).toBe(6_300_000);
		}
		expect((await listExpenses(tenant.campaignId, tenant, supportId)).statusCode).toBe(403);
	});

	it('lets only the owner and the finance manager create, edit and delete', async () => {
		const body = { category: 'otros', detail: 'No autorizado', amountMinor: 100, spentOn: '2026-10-04' };
		const target = (await listExpenses(tenant.campaignId)).json().expenses[0] as Expense;
		for (const userId of [auditorId, tenant.operatorId, supportId]) {
			const auth = await adminHeaders(ctx, tenant, userId);
			expect((await createExpense(tenant.campaignId, body, tenant, userId)).statusCode).toBe(403);
			expect((await ctx.app.inject({ method: 'PATCH', url: expensesUrl(tenant.campaignId, target.id), headers: auth, payload: { amountMinor: 1 } })).statusCode).toBe(403);
			expect((await ctx.app.inject({ method: 'DELETE', url: expensesUrl(tenant.campaignId, target.id), headers: auth })).statusCode).toBe(403);
		}
		const list = (await listExpenses(tenant.campaignId)).json();
		expect(list.totalMinor).toBe(6_300_000);
		expect(list.expenses).toHaveLength(3);
	});

	it('creates a trimmed expense in the organization currency and audits it', async () => {
		const response = await createExpense(tenant.campaignId, { category: 'publicidad', detail: '  Anuncio en radio  ', amountMinor: 250_000, spentOn: '2026-10-04' }, tenant, financeId);
		expect(response.statusCode, response.body).toBe(201);
		const expense = response.json().expense as Expense;
		expect(expense).toMatchObject({ category: 'publicidad', detail: 'Anuncio en radio', amountMinor: 250_000, currency: 'ARS', spentOn: '2026-10-04' });
		const [event] = await auditOf('expense.created', expense.id);
		expect(event).toMatchObject({ actorType: 'admin', actorId: financeId, targetType: 'campaign', targetId: tenant.campaignId });
		expect(event!.metadata).toEqual({ expenseId: expense.id, category: 'publicidad', amountMinor: 250_000, spentOn: '2026-10-04' });
		expect((await overview(tenant, tenant.campaignId)).kpis.expensesMinor).toBe(6_550_000);
	});

	it('refuses invalid expenses with Spanish messages and stores nothing', async () => {
		const before = (await listExpenses(tenant.campaignId)).json().totalMinor;
		const response = await createExpense(tenant.campaignId, { category: 'viaticos', detail: '   ', amountMinor: 0, spentOn: '2026-02-30' });
		expect(response.statusCode).toBe(400);
		expect(response.json().error).toMatchObject({
			code: 'invalid_request',
			message: 'Revisá los datos enviados',
			details: {
				fieldErrors: {
					category: ['Elegí una categoría de la lista'],
					detail: ['Describí el gasto'],
					amountMinor: ['Indicá un importe mayor que cero, en centavos'],
					spentOn: ['Indicá la fecha del gasto (AAAA-MM-DD)']
				}
			}
		});
		const fractional = await createExpense(tenant.campaignId, { category: 'otros', detail: 'Cambio', amountMinor: 10.5, spentOn: '2026-10-04' });
		expect(fractional.json().error.details.fieldErrors).toEqual({ amountMinor: ['Indicá un importe mayor que cero, en centavos'] });
		const long = await createExpense(tenant.campaignId, { category: 'otros', detail: 'x'.repeat(201), amountMinor: 100, spentOn: '2026-10-04' });
		expect(long.json().error.details.fieldErrors).toEqual({ detail: ['El detalle admite hasta 200 caracteres'] });
		const huge = await createExpense(tenant.campaignId, { category: 'otros', detail: 'Enorme', amountMinor: 1_000_000_000_001, spentOn: '2026-10-04' });
		expect(huge.json().error.details.fieldErrors).toEqual({ amountMinor: ['El importe es demasiado grande'] });
		expect((await listExpenses(tenant.campaignId)).json().totalMinor).toBe(before);
	});

	it('edits an expense, audits the fields that changed, and the overview follows', async () => {
		const expense = await newExpense(tenant.campaignId, { category: 'otros', detail: 'Fotocopias', amountMinor: 10_000, spentOn: '2026-10-06' });
		const before = (await overview(tenant, tenant.campaignId)).kpis.expensesMinor;
		const response = await ctx.app.inject({
			method: 'PATCH',
			url: expensesUrl(tenant.campaignId, expense.id),
			headers: await adminHeaders(ctx, tenant, financeId),
			payload: { amountMinor: 25_000, category: 'publicidad', detail: 'Volantes' }
		});
		expect(response.statusCode, response.body).toBe(200);
		expect(response.json().expense).toMatchObject({ id: expense.id, category: 'publicidad', detail: 'Volantes', amountMinor: 25_000, spentOn: '2026-10-06' });
		const [event] = await auditOf('expense.updated', expense.id);
		expect(event).toMatchObject({ actorId: financeId, targetType: 'campaign', targetId: tenant.campaignId });
		expect(event!.metadata).toEqual({
			expenseId: expense.id,
			category: 'publicidad',
			amountMinor: 25_000,
			spentOn: '2026-10-06',
			changed: ['category', 'detail', 'amountMinor'],
			before: { category: 'otros', amountMinor: 10_000 },
			after: { category: 'publicidad', amountMinor: 25_000 }
		});
		expect((await overview(tenant, tenant.campaignId)).kpis.expensesMinor).toBe(before + 15_000);

		const empty = await ctx.app.inject({ method: 'PATCH', url: expensesUrl(tenant.campaignId, expense.id), headers: await adminHeaders(ctx, tenant), payload: {} });
		expect(empty.statusCode).toBe(400);
		expect(empty.json().error.details.formErrors).toEqual(['Indicá qué cambiar del gasto']);
	});

	it('deletes an expense, which leaves the totals, and audits it', async () => {
		const expense = await newExpense(tenant.campaignId, { category: 'otros', detail: 'Para borrar', amountMinor: 70_000, spentOn: '2026-10-07' });
		const before = await overview(tenant, tenant.campaignId);
		const auth = await adminHeaders(ctx, tenant);
		const response = await ctx.app.inject({ method: 'DELETE', url: expensesUrl(tenant.campaignId, expense.id), headers: auth });
		expect(response.statusCode, response.body).toBe(200);
		expect(response.json()).toEqual({ ok: true });
		const after = await overview(tenant, tenant.campaignId);
		expect(after.kpis.expensesMinor).toBe(before.kpis.expensesMinor - 70_000);
		expect(after.kpis.projectedNetMinor).toBe(before.kpis.projectedNetMinor + 70_000);
		expect((await listExpenses(tenant.campaignId)).json().expenses.map((row: Expense) => row.id)).not.toContain(expense.id);
		const [event] = await auditOf('expense.deleted', expense.id);
		expect(event).toMatchObject({ actorId: tenant.ownerId, targetType: 'campaign', targetId: tenant.campaignId });
		expect(event!.metadata).toEqual({ expenseId: expense.id, category: 'otros', amountMinor: 70_000, spentOn: '2026-10-07' });
		expect((await ctx.app.inject({ method: 'DELETE', url: expensesUrl(tenant.campaignId, expense.id), headers: auth })).statusCode).toBe(404);
	});

	it('publishes a change notice for the campaign, so the live overview refreshes', async () => {
		const { lastEventId } = await overview();
		const expense = await newExpense(tenant.campaignId, { category: 'otros', detail: 'Aviso', amountMinor: 1_000, spentOn: '2026-10-08' });
		await ctx.app.inject({ method: 'PATCH', url: expensesUrl(tenant.campaignId, expense.id), headers: await adminHeaders(ctx, tenant), payload: { amountMinor: 2_000 } });
		await ctx.app.inject({ method: 'DELETE', url: expensesUrl(tenant.campaignId, expense.id), headers: await adminHeaders(ctx, tenant) });
		const events = await ctx.db.withTenant(tenant.id, (tx) => tx.select().from(s.opsEvents).where(and(eq(s.opsEvents.organizationId, tenant.id), gt(s.opsEvents.sequence, lastEventId))));
		expect(events.map((event) => [event.kind, event.subjectId])).toEqual([
			['campaign.updated', tenant.campaignId],
			['campaign.updated', tenant.campaignId],
			['campaign.updated', tenant.campaignId]
		]);
		expect((await overview()).lastEventId).toBe(lastEventId + 3);
	});

	it('keeps each organization’s expenses to itself', async () => {
		const auth = await adminHeaders(ctx, tenant);
		const [foreign] = (await listExpenses(other.campaignId, other)).json().expenses as Expense[];
		expect((await listExpenses(other.campaignId)).statusCode).toBe(404);
		expect((await createExpense(other.campaignId, { category: 'otros', detail: 'Ajeno', amountMinor: 100, spentOn: '2026-10-04' })).statusCode).toBe(404);
		// Another organization's expense, through a campaign of this one or of the other.
		for (const campaignId of [tenant.campaignId, other.campaignId]) {
			expect((await ctx.app.inject({ method: 'PATCH', url: expensesUrl(campaignId, foreign!.id), headers: auth, payload: { amountMinor: 1 } })).statusCode).toBe(404);
			expect((await ctx.app.inject({ method: 'DELETE', url: expensesUrl(campaignId, foreign!.id), headers: auth })).statusCode).toBe(404);
		}
		const others = await overview(other);
		expect(others.kpis.expensesMinor).toBe(9_999_900);
		expect((await listExpenses(other.campaignId, other)).json().expenses).toEqual([foreign]);
	});

	it('answers 404 for an expense of another campaign of the same organization', async () => {
		const [fulfilledExpense] = (await listExpenses(campaigns.fulfilled)).json().expenses as Expense[];
		const auth = await adminHeaders(ctx, tenant);
		const response = await ctx.app.inject({ method: 'PATCH', url: expensesUrl(tenant.campaignId, fulfilledExpense!.id), headers: auth, payload: { amountMinor: 1 } });
		expect(response.statusCode).toBe(404);
		expect(response.json().error).toEqual({ code: 'not_found', message: 'Gasto no encontrado' });
		expect((await listExpenses(campaigns.fulfilled)).json().totalMinor).toBe(2_000_000);
	});
});
