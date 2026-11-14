import { randomUUID } from 'node:crypto';
import { and, asc, eq, schema as s } from '@sortea/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminHeaders, checkoutBody, createTenant, createTestContext, headers, openCampaign, type TenantFixture, type TestContext } from './helpers';

// Owner feedback 2026-11-10 (odd/tasks/owner-feedback-2026-11-10.md):
// S4, an optional alias per back-office user, set by platform staff;
// S13, a suspended organization keeps its console reachable for platform staff
// on its own domain, and its public site says it is paused (503) instead of
// "Sitio no encontrado", while it still sells nothing.

let ctx: TestContext;
let staff: Record<string, string>;
const platformAdmin = '00000000-0000-4000-8000-00000000c0a1';

beforeAll(async () => {
	ctx = await createTestContext();
	await ctx.db.withPlatform((db) => db.insert(s.platformAdmins).values({ userId: platformAdmin, email: 'console@test' }).onConflictDoNothing());
	staff = { 'x-internal-token': ctx.deps.config.INTERNAL_API_TOKEN, authorization: `Bearer ${await ctx.signAdmin(platformAdmin, 'console@test')}` };
});
afterAll(() => ctx.close());

const unique = (label: string) => `${label}-${randomUUID().slice(0, 8)}@users.test`;
const createUser = (payload: Record<string, unknown>, as: Record<string, string> = staff) => ctx.app.inject({ method: 'POST', url: '/platform/users', headers: as, payload });
const updateUser = (id: string, payload: Record<string, unknown>, as: Record<string, string> = staff) =>
	ctx.app.inject({ method: 'PATCH', url: `/platform/users/${id}`, headers: as, payload });
const listed = async (email: string) => {
	const response = await ctx.app.inject({ method: 'GET', url: '/platform/users', headers: staff });
	return response.json().users.find((user: { email: string }) => user.email === email);
};
const storedAlias = async (id: string) => (await ctx.db.withPlatform((db) => db.select({ alias: s.adminUsers.alias }).from(s.adminUsers).where(eq(s.adminUsers.id, id))))[0]?.alias;
// Ordered: without ORDER BY Postgres may return the events in any order, which made the alias test flaky.
const userAudits = (id: string) =>
	ctx.db.withPlatform((db) =>
		db
			.select()
			.from(s.auditEvents)
			.where(and(eq(s.auditEvents.targetType, 'admin_user'), eq(s.auditEvents.targetId, id)))
			.orderBy(asc(s.auditEvents.createdAt), asc(s.auditEvents.id))
	);

describe('user alias (S4)', () => {
	it('is set at creation, trimmed, listed, and audited without its value', async () => {
		const email = unique('alias');
		const created = await createUser({ email, alias: '  Pato de plataforma  ' });
		expect(created.statusCode).toBe(201);
		expect(created.json().user).toEqual({ id: expect.any(String), email, alias: 'Pato de plataforma', platformAdmin: false });
		const id = created.json().user.id as string;
		expect(await storedAlias(id)).toBe('Pato de plataforma');
		expect(await listed(email)).toMatchObject({ id, email, alias: 'Pato de plataforma' });
		const [event, ...rest] = await userAudits(id);
		expect(rest).toEqual([]);
		expect(event).toMatchObject({ action: 'admin_user.created', actorType: 'platform_admin', actorId: platformAdmin, metadata: { platformAdmin: false, alias: true } });
		expect(JSON.stringify(event!.metadata)).not.toContain('Pato');
	});

	it('is optional: missing or blank stores none', async () => {
		const missing = await createUser({ email: unique('sin-alias') });
		expect(missing.json().user.alias).toBeNull();
		const blank = await createUser({ email: unique('alias-vacio'), alias: '   ' });
		expect(blank.statusCode).toBe(201);
		expect(await storedAlias(blank.json().user.id)).toBeNull();
	});

	it('refuses more than 60 characters and creates nothing', async () => {
		const email = unique('alias-largo');
		const refused = await createUser({ email, alias: 'x'.repeat(61) });
		expect(refused.statusCode).toBe(400);
		expect(refused.json().error.details.fieldErrors.alias).toEqual(['El alias puede tener hasta 60 caracteres']);
		expect(await listed(email)).toBeUndefined();
		expect((await createUser({ email, alias: 'x'.repeat(60) })).statusCode).toBe(201);
	});

	it('is edited and removed by platform staff, each change audited without the value', async () => {
		const email = unique('editar');
		const id = (await createUser({ email })).json().user.id as string;
		const updated = await updateUser(id, { alias: ' Ventas ' });
		expect(updated.statusCode).toBe(200);
		expect(updated.json().user).toEqual({ id, email, alias: 'Ventas' });
		expect(await storedAlias(id)).toBe('Ventas');
		const removed = await updateUser(id, { alias: '' });
		expect(removed.json().user.alias).toBeNull();
		expect(await storedAlias(id)).toBeNull();
		const changes = (await userAudits(id)).filter((event) => event.action === 'admin_user.alias_updated');
		expect(changes.map((event) => event.metadata)).toEqual([{ alias: true }, { alias: false }]);
		expect(changes.every((event) => event.actorType === 'platform_admin' && event.actorId === platformAdmin)).toBe(true);
	});

	it('refuses an edit without the alias field, keeping the stored one', async () => {
		const email = unique('sin-campo');
		const id = (await createUser({ email, alias: 'Original' })).json().user.id as string;
		const refused = await updateUser(id, {});
		expect(refused.statusCode).toBe(400);
		expect(refused.json().error).toMatchObject({ code: 'invalid_request', details: { fieldErrors: { alias: ['Indicá el alias, o dejalo vacío para quitarlo'] } } });
		expect(await storedAlias(id)).toBe('Original');
		expect((await userAudits(id)).filter((event) => event.action === 'admin_user.alias_updated')).toEqual([]);
		const removed = await updateUser(id, { alias: null });
		expect([removed.statusCode, removed.json().user.alias]).toEqual([200, null]);
		expect(await storedAlias(id)).toBeNull();
	});

	it('refuses a long alias, an unknown user and organization staff, changing nothing', async () => {
		const email = unique('rechazos');
		const id = (await createUser({ email, alias: 'Original' })).json().user.id as string;
		const long = await updateUser(id, { alias: 'y'.repeat(61) });
		expect([long.statusCode, long.json().error.details.fieldErrors.alias]).toEqual([400, ['El alias puede tener hasta 60 caracteres']]);
		const unknown = await updateUser(randomUUID(), { alias: 'Nadie' });
		expect([unknown.statusCode, unknown.json().error.code]).toEqual([404, 'not_found']);
		const tenant = await createTenant(ctx, 'alias-staff');
		const owner = await adminHeaders(ctx, tenant);
		expect((await updateUser(id, { alias: 'Dueño' }, owner)).statusCode).toBe(403);
		expect((await createUser({ email: unique('x'), alias: 'Dueño' }, owner)).statusCode).toBe(403);
		expect(await storedAlias(id)).toBe('Original');
		expect((await userAudits(id)).filter((event) => event.action === 'admin_user.alias_updated')).toEqual([]);
	});

	it('is shown with the members of an organization', async () => {
		const tenant = await createTenant(ctx, 'alias-members');
		// Fixture members get their account when they first sign in.
		await adminHeaders(ctx, tenant);
		expect((await updateUser(tenant.ownerId, { alias: 'Dueña del taller' })).statusCode).toBe(200);
		const detail = await ctx.app.inject({ method: 'GET', url: `/platform/organizations/${tenant.id}`, headers: staff });
		expect(detail.json().members).toEqual(
			expect.arrayContaining([
				{ userId: tenant.ownerId, email: `owner@${tenant.host}`, alias: 'Dueña del taller', role: 'org_owner', status: 'active' },
				{ userId: tenant.operatorId, email: `operator@${tenant.host}`, alias: null, role: 'campaign_operator', status: 'active' }
			])
		);
	});
});

describe('alias in the panel session (S4)', () => {
	it('names the signed-in user by the alias, and by none once removed', async () => {
		const tenant = await createTenant(ctx, 'alias-session');
		const session = async () => (await ctx.app.inject({ method: 'GET', url: '/admin/session', headers: { ...staff, 'x-tenant-host': tenant.host } })).json().user;
		expect((await updateUser(platformAdmin, { alias: 'Consola' })).statusCode).toBe(200);
		expect(await session()).toMatchObject({ id: platformAdmin, email: 'console@test', alias: 'Consola' });
		expect((await updateUser(platformAdmin, { alias: null })).statusCode).toBe(200);
		expect((await session()).alias).toBeNull();
	});
});

describe('suspended organization (S13)', () => {
	let tenant: TenantFixture;
	const setStatus = (status: 'active' | 'suspended') =>
		ctx.app.inject({ method: 'POST', url: `/platform/organizations/${tenant.id}/status`, headers: staff, payload: { status } });
	const site = () => ctx.app.inject({ method: 'GET', url: '/public/site', headers: headers(tenant) });

	beforeAll(async () => {
		tenant = await createTenant(ctx, 'suspended');
		await openCampaign(ctx, tenant);
		// Warms the host cache: the status change must not wait for it to expire.
		expect((await site()).statusCode).toBe(200);
		expect((await setStatus('suspended')).json().status).toBe('suspended');
	});

	it('answers its public site with 503 and a plain message, without internal details', async () => {
		const response = await site();
		expect(response.statusCode).toBe(503);
		expect(response.json().error).toEqual({ code: 'site_suspended', message: 'Este sitio está pausado momentáneamente' });
		expect(response.body).not.toContain(tenant.id);
		expect((await ctx.app.inject({ method: 'GET', url: '/public/products', headers: headers(tenant) })).statusCode).toBe(503);
	});

	it('sells nothing: checkout is refused and no order is created', async () => {
		const response = await ctx.app.inject({ method: 'POST', url: '/checkout/orders', headers: headers(tenant), payload: checkoutBody(tenant) });
		expect([response.statusCode, response.json().error.code]).toEqual([503, 'site_suspended']);
		const orders = await ctx.db.withTenant(tenant.id, (tx) => tx.select({ id: s.orders.id }).from(s.orders));
		expect(orders).toEqual([]);
	});

	it('answers every buyer route with 503 site_suspended and creates no order', async () => {
		const routes = [
			{ method: 'GET', url: '/public/site' },
			{ method: 'GET', url: '/public/products' },
			{ method: 'GET', url: '/public/campaigns' },
			{ method: 'POST', url: '/checkout/quote', payload: checkoutBody(tenant) },
			{ method: 'POST', url: '/checkout/orders', payload: checkoutBody(tenant) },
			{ method: 'POST', url: '/lookup/start', payload: { documentType: 'DNI', documentNumber: '30111222' } },
			{ method: 'GET', url: '/public/tracking-links/x' }
		] as const;
		for (const route of routes) {
			const response = await ctx.app.inject({ ...route, headers: headers(tenant) });
			expect([route.url, response.statusCode, response.json().error.code]).toEqual([route.url, 503, 'site_suspended']);
		}
		const orders = await ctx.db.withTenant(tenant.id, (tx) => tx.select({ id: s.orders.id }).from(s.orders));
		expect(orders).toEqual([]);
	});

	it('keeps the console reachable for platform staff on its own domain', async () => {
		const session = await ctx.app.inject({ method: 'GET', url: '/admin/session', headers: { ...staff, 'x-tenant-host': tenant.host } });
		expect(session.statusCode).toBe(200);
		expect(session.json()).toMatchObject({ role: 'platform_superadmin', organization: { slug: expect.any(String), status: 'suspended' } });
		expect((await ctx.app.inject({ method: 'GET', url: `/platform/organizations/${tenant.id}`, headers: { ...staff, 'x-tenant-host': tenant.host } })).statusCode).toBe(200);
		// The site editor picks the home products from this list, so it must load while suspended.
		const products = await ctx.app.inject({ method: 'GET', url: '/admin/products', headers: { ...staff, 'x-tenant-host': tenant.host } });
		expect([products.statusCode, Array.isArray(products.json().products)]).toEqual([200, true]);
	});

	it("refuses the organization's own staff with a clear message", async () => {
		const response = await ctx.app.inject({ method: 'GET', url: '/admin/session', headers: await adminHeaders(ctx, tenant) });
		expect(response.statusCode).toBe(403);
		expect(response.json().error).toMatchObject({ code: 'organization_suspended', message: 'La organización está suspendida. Escribile al equipo de plataforma para reactivarla.' });
	});

	it('an unknown host is still "not found", and reactivating brings the site back at once', async () => {
		const unknown = await ctx.app.inject({ method: 'GET', url: '/public/site', headers: headers({ host: `nadie-${randomUUID().slice(0, 8)}.test` }) });
		expect([unknown.statusCode, unknown.json().error.code]).toEqual([404, 'unknown_tenant']);
		expect((await setStatus('active')).statusCode).toBe(200);
		expect((await site()).statusCode).toBe(200);
		const session = await ctx.app.inject({ method: 'GET', url: '/admin/session', headers: await adminHeaders(ctx, tenant) });
		expect([session.statusCode, session.json().organization.status]).toEqual([200, 'active']);
		const actions = await ctx.db.withTenant(tenant.id, (tx) =>
			tx.select({ action: s.auditEvents.action }).from(s.auditEvents).where(and(eq(s.auditEvents.organizationId, tenant.id), eq(s.auditEvents.targetType, 'organization')))
		);
		expect(actions.map((row) => row.action)).toEqual(expect.arrayContaining(['organization.suspended', 'organization.active']));
	});
});
