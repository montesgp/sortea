import { eq, schema as s } from '@sortea/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminHeaders, checkoutBody, createTenant, createTestContext, placeOrder, webhookRequest, type TenantFixture, type TestContext } from './helpers';

// S4 (owner feedback 2026-10-22): staff find an order by its reference, the buyer's name
// or the buyer's email. Name and email only match for admins holding `orders.pii` (ADR 0010),
// so nobody else can confirm a stranger's email by trial.

let ctx: TestContext;
let tenant: TenantFixture;
let ana: Awaited<ReturnType<typeof placeOrder>>;
let bruno: Awaited<ReturnType<typeof placeOrder>>;

const buyer = (person: Record<string, string>) => ({ ...(checkoutBody(tenant).buyer as Record<string, unknown>), ...person });

beforeAll(async () => {
	ctx = await createTestContext();
	tenant = await createTenant(ctx, 'search');
	ana = await placeOrder(ctx, tenant, { buyer: buyer({ documentNumber: '30111222', firstName: 'Ana', lastName: 'Pérez', email: 'ana.perez@correo.test' }) });
	bruno = await placeOrder(ctx, tenant, { buyer: buyer({ documentNumber: '30333444', firstName: 'Bruno', lastName: 'Gómez', email: 'bgomez@otro.test' }) });
	await ctx.app.inject(webhookRequest(tenant, ctx.simulator.pay(ana.preferenceId, 'approved').id));
});
afterAll(() => ctx.close());

async function search(q: string, userId = tenant.ownerId, status?: string) {
	const params = new URLSearchParams({ q });
	if (status) params.set('status', status);
	const response = await ctx.app.inject({ method: 'GET', url: `/admin/orders?${params}`, headers: await adminHeaders(ctx, tenant, userId) });
	expect(response.statusCode).toBe(200);
	const body = response.json() as { orders: { reference: string }[]; total: number };
	return { references: body.orders.map((order) => order.reference), total: body.total };
}

describe('orders search (S4)', () => {
	it('finds an order by its reference, as before, for every admin', async () => {
		for (const userId of [tenant.ownerId, tenant.operatorId]) {
			expect(await search(ana.reference.slice(-6).toLowerCase(), userId)).toEqual({ references: [ana.reference], total: 1 });
		}
		// % and _ are stripped instead of acting as wildcards.
		expect((await search('%')).total).toBe(2);
		expect((await search('_')).total).toBe(2);
	});

	it('a holder of orders.pii finds the buyer by partial last name, full name or email fragment, ignoring case', async () => {
		expect(await search('pére')).toEqual({ references: [ana.reference], total: 1 });
		expect(await search('Ana Pérez')).toEqual({ references: [ana.reference], total: 1 });
		expect(await search('ANA PÉREZ')).toEqual({ references: [ana.reference], total: 1 });
		expect(await search('perez@CORREO')).toEqual({ references: [ana.reference], total: 1 });
		expect(await search('bruno')).toEqual({ references: [bruno.reference], total: 1 });
	});

	it('ignores accents in the buyer name', async () => {
		expect(await search('perez')).toEqual({ references: [ana.reference], total: 1 });
		expect(await search('gomez')).toEqual({ references: [bruno.reference], total: 1 });
	});

	it('an admin without orders.pii gets no match from the buyer name or email', async () => {
		for (const q of ['ana.perez@correo.test', 'perez@correo', 'Ana Pérez', 'Pérez', 'Bruno']) {
			expect(await search(q, tenant.operatorId)).toEqual({ references: [], total: 0 });
		}
	});

	it('combines the search with the status filter', async () => {
		expect(await search('Pérez', tenant.ownerId, 'paid')).toEqual({ references: [ana.reference], total: 1 });
		expect(await search('Pérez', tenant.ownerId, 'pending_payment')).toEqual({ references: [], total: 0 });
		expect(await search('Bruno', tenant.ownerId, 'pending_payment')).toEqual({ references: [bruno.reference], total: 1 });
	});

	it('does not write the search term to the audit log', async () => {
		await search('perez@correo');
		const events = await ctx.db.withTenant(tenant.id, (tx) => tx.select().from(s.auditEvents).where(eq(s.auditEvents.organizationId, tenant.id)));
		expect(JSON.stringify(events)).not.toContain('perez@correo');
	});

	it('never fails on a backslash and treats repeated spaces as one', async () => {
		expect((await search('\\')).total).toBe(0);
		expect(await search('Ana   Pérez')).toEqual({ references: [ana.reference], total: 1 });
	});
});
