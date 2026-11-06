import { eq, schema as s } from '@sortea/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminHeaders, checkoutBody, createTenant, createTestContext, placeOrder, type TenantFixture, type TestContext } from './helpers';

// Back office polish 2026-11-06: orders filtered by creation date (S3) and a
// paginated, filterable audit log (S5). Days are whole days in the
// organization's time zone (America/Argentina/Buenos_Aires, UTC-3).

let ctx: TestContext;
let tenant: TenantFixture;
let other: TenantFixture;
const orders: Record<string, string> = {};

const buyer = (person: Record<string, string>) => ({ ...(checkoutBody(tenant).buyer as Record<string, unknown>), ...person });

beforeAll(async () => {
	ctx = await createTestContext();
	tenant = await createTenant(ctx, 'filters');
	other = await createTenant(ctx, 'filters-other');
	// Creation times around the local midnights of 2026-11-01 and 2026-11-02.
	const placed = {
		lastOfOctober: ['Ana', 'Pérez', '30111222', '2026-11-01T02:59:59Z'],
		firstOfNovember: ['Bruno', 'Gómez', '30333444', '2026-11-01T03:00:00Z'],
		endOfFirst: ['Carla', 'Díaz', '30555666', '2026-11-02T02:59:59Z'],
		second: ['Ana', 'Ríos', '30777888', '2026-11-02T03:00:00Z']
	} as const;
	for (const [key, [firstName, lastName, documentNumber, createdAt]] of Object.entries(placed)) {
		const order = await placeOrder(ctx, tenant, { buyer: buyer({ firstName, lastName, documentNumber, email: `${documentNumber}@correo.test` }) });
		await ctx.db.withTenant(tenant.id, (tx) => tx.update(s.orders).set({ createdAt: new Date(createdAt) }).where(eq(s.orders.reference, order.reference)));
		orders[key] = order.reference;
	}
	// The other organization has an order on the same day.
	const foreign = await placeOrder(ctx, other, { buyer: { ...(checkoutBody(other).buyer as Record<string, unknown>), firstName: 'Ana' } });
	await ctx.db.withTenant(other.id, (tx) => tx.update(s.orders).set({ createdAt: new Date('2026-11-01T12:00:00Z') }).where(eq(s.orders.reference, foreign.reference)));
});
afterAll(() => ctx.close());

async function get(url: string, fixture = tenant, userId = fixture.ownerId) {
	return ctx.app.inject({ method: 'GET', url, headers: await adminHeaders(ctx, fixture, userId) });
}

async function listOrders(query: Record<string, string>) {
	const response = await get(`/admin/orders?${new URLSearchParams(query)}`);
	expect(response.statusCode).toBe(200);
	const body = response.json() as { orders: { reference: string }[]; total: number };
	return { references: body.orders.map((order) => order.reference).sort(), total: body.total };
}

const sorted = (...keys: string[]) => keys.map((key) => orders[key]!).sort();

describe('orders by creation date (S3)', () => {
	it('takes Desde and Hasta as whole days in the organization time zone', async () => {
		expect(await listOrders({ from: '2026-11-01', to: '2026-11-01' })).toEqual({ references: sorted('firstOfNovember', 'endOfFirst'), total: 2 });
		expect(await listOrders({ from: '2026-11-02' })).toEqual({ references: sorted('second'), total: 1 });
		expect(await listOrders({ to: '2026-10-31' })).toEqual({ references: sorted('lastOfOctober'), total: 1 });
		expect(await listOrders({ from: '2026-10-31', to: '2026-11-02' })).toEqual({ references: sorted('lastOfOctober', 'firstOfNovember', 'endOfFirst', 'second'), total: 4 });
	});

	it('combines the dates with the text search and the status filter', async () => {
		expect(await listOrders({ q: 'Ana', from: '2026-11-01' })).toEqual({ references: sorted('second'), total: 1 });
		expect(await listOrders({ q: 'Ana', to: '2026-11-01' })).toEqual({ references: sorted('lastOfOctober'), total: 1 });
		expect(await listOrders({ status: 'pending_payment', from: '2026-11-01', to: '2026-11-01' })).toEqual({ references: sorted('firstOfNovember', 'endOfFirst'), total: 2 });
		expect(await listOrders({ status: 'paid', from: '2026-11-01', to: '2026-11-01' })).toEqual({ references: [], total: 0 });
	});

	it('treats empty dates as no filter', async () => {
		expect((await listOrders({ from: '', to: '' })).total).toBe(4);
	});

	it('refuses a Desde after Hasta and dates that do not exist, in Spanish', async () => {
		const reversed = await get('/admin/orders?from=2026-11-02&to=2026-11-01');
		expect(reversed.statusCode).toBe(400);
		expect(reversed.json()).toMatchObject({ error: { code: 'invalid_date_range', message: 'La fecha "Desde" no puede ser posterior a la fecha "Hasta"' } });
		for (const bad of ['from=2026-02-30', 'to=01/11/2026', 'from=hoy']) {
			const response = await get(`/admin/orders?${bad}`);
			expect(response.statusCode).toBe(400);
			expect(response.json()).toMatchObject({ error: { code: 'invalid_date', message: 'Ingresá fechas válidas (día, mes y año)' } });
		}
	});

	it('never lists another organization’s orders', async () => {
		const mine = await listOrders({ q: 'Ana', from: '2026-11-01', to: '2026-11-01' });
		expect(mine).toEqual({ references: [], total: 0 });
	});
});

interface AuditPage {
	events: { action: string; actorType: string; targetType: string; targetId: string | null; metadata: Record<string, unknown>; createdAt: string }[];
	page: number;
	pageSize: number;
	total: number;
	actions: string[];
}

describe('audit log pages and filters (S5)', () => {
	let base: number;

	beforeAll(async () => {
		// 60 events one minute apart from 2026-11-01 02:00Z (local 2026-10-31 23:00), plus two in the same instant.
		base = Date.parse('2026-11-01T02:00:00Z');
		const rows = Array.from({ length: 60 }, (_, index) => ({
			organizationId: tenant.id,
			actorType: index % 2 ? 'admin' : 'system',
			actorId: null,
			action: index % 3 ? 'order.pii_viewed' : 'campaign.transition',
			targetType: index % 3 ? 'order' : 'campaign',
			targetId: `target-${index}`,
			metadata: { index },
			createdAt: new Date(base + index * 60_000)
		}));
		const twins = ['twin-a', 'twin-b'].map((targetId) => ({ organizationId: tenant.id, actorType: 'admin', actorId: null, action: 'order.twin', targetType: 'order', targetId, metadata: {}, createdAt: new Date('2026-11-05T12:00:00Z') }));
		await ctx.db.withPlatform((db) =>
			db.insert(s.auditEvents).values([...rows, ...twins, { organizationId: other.id, actorType: 'admin', actorId: null, action: 'order.pii_viewed', targetType: 'order', targetId: 'foreign', metadata: {}, createdAt: new Date(base) }])
		);
	});

	async function audit(query: Record<string, string> = {}, fixture = tenant) {
		const response = await get(`/admin/audit?${new URLSearchParams(query)}`, fixture);
		expect(response.statusCode).toBe(200);
		return response.json() as AuditPage;
	}

	// Checkout and other setup write their own events; the tests filter to the seeded ones.
	const seeded = { from: '2026-10-31', to: '2026-11-01' };

	it('pages the events newest first with a total', async () => {
		const first = await audit(seeded);
		expect(first).toMatchObject({ page: 1, pageSize: 50, total: 60 });
		expect(first.events).toHaveLength(50);
		expect(first.events[0]!.targetId).toBe('target-59');
		expect(first.events[49]!.targetId).toBe('target-10');
		const second = await audit({ ...seeded, page: '2' });
		expect(second.events.map((event) => event.targetId)).toEqual(Array.from({ length: 10 }, (_, index) => `target-${9 - index}`));
		const small = await audit({ ...seeded, limit: '7', page: '3' });
		expect(small).toMatchObject({ page: 3, pageSize: 7, total: 60 });
		expect(small.events.map((event) => event.targetId)).toEqual(['target-45', 'target-44', 'target-43', 'target-42', 'target-41', 'target-40', 'target-39']);
	});

	it('keeps a stable order for events written in the same instant', async () => {
		const ids = new Set<string | null>();
		for (const page of ['1', '2']) {
			const result = await audit({ action: 'order.twin', limit: '1', page });
			expect(result.total).toBe(2);
			ids.add(result.events[0]!.targetId);
		}
		expect(ids).toEqual(new Set(['twin-a', 'twin-b']));
	});

	it('filters by action, origin, object id and local days', async () => {
		expect((await audit({ ...seeded, action: 'campaign.transition' })).total).toBe(20);
		expect((await audit({ ...seeded, action: 'campaign.transition', actor: 'admin' })).total).toBe(10);
		expect((await audit({ target: 'target-7' })).events.map((event) => event.targetId)).toEqual(['target-7']);
		// Local 2026-10-31 ends at 03:00Z: the first 60 minutes are that day.
		expect((await audit({ from: '2026-10-31', to: '2026-10-31' })).total).toBe(60);
		expect((await audit({ from: '2026-11-01', to: '2026-11-01', action: 'order.pii_viewed' })).total).toBe(0);
	});

	it('offers the actions this organization has recorded', async () => {
		const { actions } = await audit();
		expect(actions).toEqual(expect.arrayContaining(['campaign.transition', 'order.pii_viewed', 'order.twin']));
		expect(actions).toEqual([...actions].sort());
	});

	it('refuses bad pages, limits and ranges', async () => {
		for (const query of ['page=0', 'limit=101', 'limit=0', 'actor=hacker']) {
			expect((await get(`/admin/audit?${query}`)).statusCode).toBe(400);
		}
		const reversed = await get('/admin/audit?from=2026-11-02&to=2026-11-01');
		expect(reversed.statusCode).toBe(400);
		expect(reversed.json()).toMatchObject({ error: { code: 'invalid_date_range' } });
	});

	it('never shows another organization’s events', async () => {
		expect((await audit({ target: 'foreign' })).total).toBe(0);
		const foreign = await audit({}, other);
		expect(foreign.events.map((event) => event.targetId)).not.toContain('target-0');
	});

	it('stays behind audit.view and returns no actor ids', async () => {
		expect((await get('/admin/audit', tenant, tenant.operatorId)).statusCode).toBe(403);
		const { events } = await audit({ target: 'target-1' });
		expect(Object.keys(events[0]!).sort()).toEqual(['action', 'actorType', 'createdAt', 'metadata', 'targetId', 'targetType']);
	});
});
