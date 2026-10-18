import { and, eq, schema as s } from '@sortea/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminHeaders, createTenant, createTestContext, headers, INTERNAL_TOKEN, type TenantFixture, type TestContext } from './helpers';

// S8 (feedback 2026-10-18): each organization sets its Instagram, TikTok,
// YouTube and Facebook links in the back office; the public site shows them.

let ctx: TestContext;
let tenant: TenantFixture;
let other: TenantFixture;
let platformAuth: Record<string, string>;
const platformAdmin = '00000000-0000-4000-8000-00000000a0d1';
const links = {
	instagram: 'https://www.instagram.com/motogaragearrecifes/',
	tiktok: 'https://www.tiktok.com/@tallermotogarage',
	youtube: 'https://www.youtube.com/@Tallermotogarage'
};

beforeAll(async () => {
	ctx = await createTestContext();
	tenant = await createTenant(ctx, 'social');
	other = await createTenant(ctx, 'social-other');
	await ctx.db.withPlatform((db) => db.insert(s.platformAdmins).values({ userId: platformAdmin, email: 'staff-social@test' }).onConflictDoNothing());
	platformAuth = { 'x-internal-token': INTERNAL_TOKEN, authorization: `Bearer ${await ctx.signAdmin(platformAdmin, 'staff-social@test')}` };
});
afterAll(() => ctx.close());

const saveOwn = (payload: Record<string, string>, auth: Record<string, string>) => ctx.app.inject({ method: 'PUT', url: '/admin/settings/social', headers: auth, payload });

async function stored(organizationId = tenant.id) {
	const [org] = await ctx.db.withPlatform((db) => db.select({ settings: s.organizations.settings }).from(s.organizations).where(eq(s.organizations.id, organizationId)));
	return org!.settings;
}

async function publicSocial(fixture = tenant) {
	const response = await ctx.app.inject({ method: 'GET', url: '/public/site', headers: headers(fixture) });
	expect(response.statusCode).toBe(200);
	return response.json().social as Record<string, unknown>;
}

describe('social links (S8)', () => {
	it('the owner saves them, the rest of the settings stay, it is audited and the site shows them at once', async () => {
		const before = await stored();
		const response = await saveOwn(links, await adminHeaders(ctx, tenant));
		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({ social: links });
		const after = await stored();
		expect(after.social).toEqual(links);
		expect({ ...after, social: before.social }).toEqual(before);
		expect(await publicSocial()).toEqual(links);
		const [event] = await ctx.db.withTenant(tenant.id, (tx) =>
			tx.select().from(s.auditEvents).where(and(eq(s.auditEvents.organizationId, tenant.id), eq(s.auditEvents.action, 'organization.social_updated')))
		);
		expect(event).toMatchObject({ actorType: 'admin', actorId: tenant.ownerId, metadata: { networks: ['instagram', 'tiktok', 'youtube'] } });

		const read = await ctx.app.inject({ method: 'GET', url: '/admin/settings', headers: await adminHeaders(ctx, tenant) });
		expect(read.json().social).toEqual(links);
	});

	it('an empty field removes that network from the site', async () => {
		const response = await saveOwn({ ...links, tiktok: '' }, await adminHeaders(ctx, tenant));
		expect(response.json()).toEqual({ social: { instagram: links.instagram, youtube: links.youtube } });
		expect(await publicSocial()).toEqual({ instagram: links.instagram, youtube: links.youtube });
	});

	it('refuses a link of another network, saying which field, and keeps what was saved', async () => {
		const response = await saveOwn({ ...links, youtube: 'https://www.tiktok.com/@tallermotogarage' }, await adminHeaders(ctx, tenant));
		expect(response.statusCode).toBe(400);
		expect(response.json().error.details.fieldErrors.youtube).toEqual(['Pegá el enlace completo de tu perfil de YouTube, empezando por https://']);
		expect((await stored()).social).toEqual({ instagram: links.instagram, youtube: links.youtube });
	});

	it('operators and finance cannot change them; another organization only changes its own', async () => {
		const finance = '00000000-0000-4000-8000-00000000a0d2';
		await ctx.db.withPlatform((db) => db.insert(s.organizationMembers).values({ organizationId: tenant.id, userId: finance, email: 'finance@social.test', role: 'finance_manager' }));
		for (const userId of [tenant.operatorId, finance]) {
			expect((await saveOwn({ tiktok: links.tiktok }, await adminHeaders(ctx, tenant, userId))).statusCode).toBe(403);
		}
		const foreign = headers(tenant, { authorization: `Bearer ${await ctx.signAdmin(other.ownerId, 'owner@other.test')}` });
		expect((await saveOwn({ tiktok: links.tiktok }, foreign)).statusCode).toBe(403);
		expect((await saveOwn({ facebook: 'https://facebook.com/other' }, await adminHeaders(ctx, other))).statusCode).toBe(200);
		expect((await stored()).social).toEqual({ instagram: links.instagram, youtube: links.youtube });
		expect(await publicSocial(other)).toEqual({ facebook: 'https://facebook.com/other' });
	});

	it('platform staff set them for an organization from the console', async () => {
		const response = await ctx.app.inject({ method: 'PUT', url: `/platform/organizations/${tenant.id}/social`, headers: platformAuth, payload: links });
		expect(response.statusCode).toBe(200);
		expect(response.json().social).toEqual(links);
		expect(await publicSocial()).toEqual(links);
		expect((await ctx.app.inject({ method: 'PUT', url: `/platform/organizations/${tenant.id}/social`, headers: await adminHeaders(ctx, tenant), payload: links })).statusCode).toBe(403);
	});

	it('the public site never shows a stored value that is not a valid link of its network', async () => {
		await ctx.db.withPlatform(async (db) => {
			const settings = await stored(other.id);
			await db.update(s.organizations).set({ settings: { ...settings, social: { instagram: 'javascript:alert(1)', tiktok: 'https://www.tiktok.com/@ok' } } }).where(eq(s.organizations.id, other.id));
		});
		ctx.app.tenants.invalidate();
		expect(await publicSocial(other)).toEqual({ tiktok: 'https://www.tiktok.com/@ok' });
	});
});
