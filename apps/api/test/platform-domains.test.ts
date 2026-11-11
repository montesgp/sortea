import { and, eq, schema as s } from '@sortea/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminHeaders, createTenant, createTestContext, headers, type TenantFixture, type TestContext } from './helpers';

// Platform staff remove a domain added by mistake (owner, 2026-11-10: "no puedo
// eliminar el dominio que agregue mal"). The organization keeps at least one
// domain, and the console never removes the host it is being used from.

let ctx: TestContext;
let auth: Record<string, string>;
const platformAdmin = '00000000-0000-4000-8000-00000000d0e1';
const consoleHost = 'console.platform.test';

beforeAll(async () => {
	ctx = await createTestContext();
	await ctx.db.withPlatform((db) => db.insert(s.platformAdmins).values({ userId: platformAdmin, email: 'domains@test' }).onConflictDoNothing());
	auth = {
		'x-internal-token': ctx.deps.config.INTERNAL_API_TOKEN,
		'x-tenant-host': consoleHost,
		authorization: `Bearer ${await ctx.signAdmin(platformAdmin, 'domains@test')}`
	};
});
afterAll(() => ctx.close());

const addDomain = (tenant: TenantFixture, hostname: string, isPrimary = false) =>
	ctx.app.inject({ method: 'POST', url: `/platform/organizations/${tenant.id}/domains`, headers: auth, payload: { hostname, isPrimary } });
const removeDomain = (organizationId: string, hostname: string, as: Record<string, string> = auth) =>
	ctx.app.inject({ method: 'DELETE', url: `/platform/organizations/${organizationId}/domains/${encodeURIComponent(hostname)}`, headers: as });
const domains = (tenant: TenantFixture) =>
	ctx.db.withPlatform((db) =>
		db.select({ hostname: s.organizationDomains.hostname, isPrimary: s.organizationDomains.isPrimary }).from(s.organizationDomains).where(eq(s.organizationDomains.organizationId, tenant.id))
	);
const audits = (tenant: TenantFixture) =>
	ctx.db.withTenant(tenant.id, (tx) =>
		tx.select().from(s.auditEvents).where(and(eq(s.auditEvents.organizationId, tenant.id), eq(s.auditEvents.action, 'organization.domain_removed')))
	);

describe('remove a domain', () => {
	it('removes the domain, audits it and the site stops answering on it at once', async () => {
		const tenant = await createTenant(ctx, 'domain-remove');
		const wrong = `wrong-${tenant.id.slice(0, 8)}.test`;
		expect((await addDomain(tenant, wrong)).statusCode).toBe(200);
		// Warms the host cache, which would otherwise keep serving the removed host for 30 seconds.
		expect((await ctx.app.inject({ method: 'GET', url: '/public/site', headers: headers({ host: wrong }) })).statusCode).toBe(200);

		const response = await removeDomain(tenant.id, wrong);
		expect(response.statusCode).toBe(200);
		expect(response.json().domains).toEqual([{ hostname: tenant.host, isPrimary: true, verifiedAt: null }]);
		expect(await domains(tenant)).toEqual([{ hostname: tenant.host, isPrimary: true }]);

		const site = await ctx.app.inject({ method: 'GET', url: '/public/site', headers: headers({ host: wrong }) });
		expect(site.statusCode).toBe(404);
		expect(site.json().error).toMatchObject({ code: 'unknown_tenant' });
		expect((await ctx.app.inject({ method: 'GET', url: '/public/site', headers: headers(tenant) })).statusCode).toBe(200);

		const [event, ...rest] = await audits(tenant);
		expect(rest).toEqual([]);
		expect(event).toMatchObject({ actorType: 'platform_admin', actorId: platformAdmin, targetType: 'organization', targetId: tenant.id, metadata: { hostname: wrong, wasPrimary: false } });
	});

	it('removing the primary domain makes the remaining one primary', async () => {
		const tenant = await createTenant(ctx, 'domain-primary');
		const other = `other-${tenant.id.slice(0, 8)}.test`;
		expect((await addDomain(tenant, other)).statusCode).toBe(200);
		const response = await removeDomain(tenant.id, tenant.host.toUpperCase());
		expect(response.statusCode).toBe(200);
		expect(await domains(tenant)).toEqual([{ hostname: other, isPrimary: true }]);
		const [event] = await audits(tenant);
		expect(event?.metadata).toEqual({ hostname: tenant.host, wasPrimary: true, primary: other });
	});

	it('refuses removing the last domain and changes nothing', async () => {
		const tenant = await createTenant(ctx, 'domain-last');
		const response = await removeDomain(tenant.id, tenant.host);
		expect(response.statusCode).toBe(409);
		expect(response.json().error).toMatchObject({
			code: 'last_domain',
			message: `No se puede quitar ${tenant.host}: es el único dominio de la organización. Agregá el dominio correcto antes de quitarlo.`
		});
		expect(await domains(tenant)).toEqual([{ hostname: tenant.host, isPrimary: true }]);
		expect(await audits(tenant)).toEqual([]);
	});

	it('refuses removing the host the console is being used from', async () => {
		const tenant = await createTenant(ctx, 'domain-console');
		expect((await addDomain(tenant, consoleHost)).statusCode).toBe(200);
		const response = await removeDomain(tenant.id, consoleHost);
		expect(response.statusCode).toBe(409);
		expect(response.json().error).toMatchObject({
			code: 'current_host',
			message: `No se puede quitar ${consoleHost}: es el dominio desde el que estás usando la consola. Entrá desde otro dominio para quitarlo.`
		});
		expect((await domains(tenant)).map((domain) => domain.hostname).sort()).toEqual([consoleHost, tenant.host].sort());
		expect(await audits(tenant)).toEqual([]);
		// Frees the host for other suites.
		expect((await removeDomain(tenant.id, consoleHost, { ...auth, 'x-tenant-host': tenant.host })).statusCode).toBe(200);
	});

	it("cannot remove another organization's domain", async () => {
		const tenant = await createTenant(ctx, 'domain-own');
		const other = await createTenant(ctx, 'domain-other');
		expect((await addDomain(tenant, `second-${tenant.id.slice(0, 8)}.test`)).statusCode).toBe(200);
		const response = await removeDomain(tenant.id, other.host);
		expect(response.statusCode).toBe(404);
		expect(response.json().error).toMatchObject({ code: 'not_found', message: 'Dominio no encontrado' });
		expect(await domains(other)).toEqual([{ hostname: other.host, isPrimary: true }]);
		expect(await audits(tenant)).toEqual([]);
		expect(await audits(other)).toEqual([]);
	});

	it('only platform staff remove domains, and an invalid hostname is refused', async () => {
		const tenant = await createTenant(ctx, 'domain-auth');
		const second = `second-${tenant.id.slice(0, 8)}.test`;
		expect((await addDomain(tenant, second)).statusCode).toBe(200);
		expect((await removeDomain(tenant.id, second, await adminHeaders(ctx, tenant))).statusCode).toBe(403);
		expect((await removeDomain(tenant.id, 'not a host')).statusCode).toBe(400);
		expect(await domains(tenant)).toHaveLength(2);
	});
});

describe('add a domain (unchanged)', () => {
	it('still adds a domain and refuses one already assigned', async () => {
		const tenant = await createTenant(ctx, 'domain-add');
		const extra = `extra-${tenant.id.slice(0, 8)}.test`;
		const added = await addDomain(tenant, extra);
		expect(added.statusCode).toBe(200);
		expect(added.json().domains).toHaveLength(2);
		const taken = await addDomain(tenant, extra);
		expect(taken.statusCode).toBe(409);
		expect(taken.json().error).toMatchObject({ code: 'hostname_taken', message: 'Ese dominio ya está asignado' });
	});
});
