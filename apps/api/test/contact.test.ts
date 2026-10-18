import { and, eq, schema as s } from '@sortea/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminHeaders, createTenant, createTestContext, headers, INTERNAL_TOKEN, type TenantFixture, type TestContext } from './helpers';

let ctx: TestContext;
let tenant: TenantFixture;
let platformAuth: Record<string, string>;
const platformAdmin = '00000000-0000-4000-8000-00000000a005';

beforeAll(async () => {
	ctx = await createTestContext();
	tenant = await createTenant(ctx, 'contact');
	await ctx.db.withPlatform((db) => db.insert(s.platformAdmins).values({ userId: platformAdmin, email: 'staff-contact@test' }).onConflictDoNothing());
	platformAuth = { 'x-internal-token': INTERNAL_TOKEN, authorization: `Bearer ${await ctx.signAdmin(platformAdmin, 'staff-contact@test')}` };
});
afterAll(() => ctx.close());

const saveWhatsApp = (whatsapp: string, auth = platformAuth) =>
	ctx.app.inject({ method: 'PUT', url: `/platform/organizations/${tenant.id}/contact`, headers: auth, payload: { whatsapp } });

async function storedSettings() {
	const [org] = await ctx.db.withPlatform((db) => db.select({ settings: s.organizations.settings }).from(s.organizations).where(eq(s.organizations.id, tenant.id)));
	return org!.settings;
}

async function publicContact() {
	const response = await ctx.app.inject({ method: 'GET', url: '/public/site', headers: headers(tenant) });
	expect(response.statusCode).toBe(200);
	return response.json().contact as Record<string, unknown>;
}

describe('organization WhatsApp number (S5)', () => {
	it('platform staff save the number normalized to digits and the public site exposes it', async () => {
		const response = await saveWhatsApp('+54 9 2478 40-7084');
		expect(response.statusCode).toBe(200);
		expect(response.json().contact).toEqual({ whatsapp: '5492478407084' });

		const settings = await storedSettings();
		expect(settings.contact.whatsapp).toBe('5492478407084');
		// Only the contact changes; delivery and the legal versions checkout records stay as they were.
		expect(settings.delivery).toEqual({ pickupEnabled: true, shippingEnabled: true, shippingFeeMinor: 500_000 });
		expect(settings.legal).toEqual({ termsVersion: 't1', privacyVersion: 'p1' });
		expect((await publicContact()).whatsapp).toBe('5492478407084');

		const audits = await ctx.db.withPlatform((db) =>
			db.select().from(s.auditEvents).where(and(eq(s.auditEvents.organizationId, tenant.id), eq(s.auditEvents.action, 'organization.contact_updated')))
		);
		expect(audits).toHaveLength(1);
		expect(audits[0]!.actorId).toBe(platformAdmin);
	});

	it('rejects a number without a country code and keeps the saved one', async () => {
		const response = await saveWhatsApp('2478 40-7084');
		expect(response.statusCode).toBe(400);
		expect(response.json().error.details.fieldErrors.whatsapp).toEqual(['Ingresá el número con código de país, por ejemplo +54 9 2478 40-7084']);
		expect((await storedSettings()).contact.whatsapp).toBe('5492478407084');
		expect((await publicContact()).whatsapp).toBe('5492478407084');
	});

	it('organization admins cannot change it through the platform route', async () => {
		const response = await saveWhatsApp('+54 9 11 5555-0000', await adminHeaders(ctx, tenant));
		expect(response.statusCode).toBe(403);
		expect((await storedSettings()).contact.whatsapp).toBe('5492478407084');
	});

	it('the public site exposes only the public contact fields, never other stored keys', async () => {
		const settings = await storedSettings();
		await ctx.db.withPlatform((db) =>
			db
				.update(s.organizations)
				.set({ settings: { ...settings, contact: { ...settings.contact, email: 'hola@example.com', internalNote: 'no publicar' } as typeof settings.contact } })
				.where(eq(s.organizations.id, tenant.id))
		);
		ctx.app.tenants.invalidate();
		expect(await publicContact()).toEqual({ email: 'hola@example.com', whatsapp: '5492478407084' });
	});

	it('an empty value removes the number', async () => {
		const response = await saveWhatsApp('');
		expect(response.statusCode).toBe(200);
		expect(response.json().contact.whatsapp).toBeUndefined();
		expect((await storedSettings()).contact).not.toHaveProperty('whatsapp');
		expect(await publicContact()).not.toHaveProperty('whatsapp');
	});

	it('a number from another country is saved and shown, not dropped', async () => {
		const response = await saveWhatsApp('+598 99 123 456');
		expect(response.statusCode).toBe(200);
		expect(response.json().contact.whatsapp).toBe('59899123456');
		expect((await storedSettings()).contact.whatsapp).toBe('59899123456');
		expect((await publicContact()).whatsapp).toBe('59899123456');
	});
});

describe('organization settings: the owner edits the WhatsApp number (S5)', () => {
	let other: TenantFixture;
	beforeAll(async () => {
		other = await createTenant(ctx, 'contact-other');
	});

	const saveOwn = async (whatsapp: string, auth: Record<string, string>) =>
		ctx.app.inject({ method: 'PUT', url: '/admin/settings/contact', headers: auth, payload: { whatsapp } });

	it('the owner and the organization admin save it for their own organization, audited', async () => {
		const owner = await saveOwn('+54 9 2478 40-7084', await adminHeaders(ctx, tenant));
		expect(owner.statusCode).toBe(200);
		expect(owner.json()).toEqual({ contact: { email: 'hola@example.com', whatsapp: '5492478407084' } });
		expect((await publicContact()).whatsapp).toBe('5492478407084');

		const orgAdmin = '00000000-0000-4000-8000-00000000a006';
		await ctx.db.withPlatform((db) => db.insert(s.organizationMembers).values({ organizationId: tenant.id, userId: orgAdmin, email: 'admin@contact.test', role: 'org_admin' }));
		const byAdmin = await saveOwn('+54 9 11 5555-0000', await adminHeaders(ctx, tenant, orgAdmin));
		expect(byAdmin.statusCode).toBe(200);
		expect((await publicContact()).whatsapp).toBe('5491155550000');

		const audits = await ctx.db.withTenant(tenant.id, (tx) => tx.select().from(s.auditEvents).where(eq(s.auditEvents.action, 'organization.contact_updated')));
		expect(audits.map((event) => [event.actorType, event.actorId])).toEqual(
			expect.arrayContaining([
				['admin', tenant.ownerId],
				['admin', orgAdmin]
			])
		);
	});

	it('reads the current contact for the settings page', async () => {
		const response = await ctx.app.inject({ method: 'GET', url: '/admin/settings', headers: await adminHeaders(ctx, tenant) });
		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({ contact: { email: 'hola@example.com', whatsapp: '5491155550000' }, social: {} });
	});

	it('operators and finance cannot read or change it', async () => {
		const finance = '00000000-0000-4000-8000-00000000a007';
		await ctx.db.withPlatform((db) => db.insert(s.organizationMembers).values({ organizationId: tenant.id, userId: finance, email: 'finance@contact.test', role: 'finance_manager' }));
		for (const userId of [tenant.operatorId, finance]) {
			const auth = await adminHeaders(ctx, tenant, userId);
			expect((await saveOwn('+54 9 2478 40-7084', auth)).statusCode).toBe(403);
			expect((await ctx.app.inject({ method: 'GET', url: '/admin/settings', headers: auth })).statusCode).toBe(403);
		}
		expect((await storedSettings()).contact.whatsapp).toBe('5491155550000');
	});

	it('an owner of another organization cannot change it, and invalid numbers are rejected', async () => {
		// The other owner signs in on this hostname: not a member here.
		const foreign = headers(tenant, { authorization: `Bearer ${await ctx.signAdmin(other.ownerId, 'owner@other.test')}` });
		expect((await saveOwn('+54 9 2478 40-7084', foreign)).statusCode).toBe(403);
		// On their own hostname they only change their own organization.
		expect((await saveOwn('+54 9 3492 00-1111', await adminHeaders(ctx, other))).statusCode).toBe(200);
		expect((await storedSettings()).contact.whatsapp).toBe('5491155550000');

		const invalid = await saveOwn('2478 40-7084', await adminHeaders(ctx, tenant));
		expect(invalid.statusCode).toBe(400);
		expect(invalid.json().error.details.fieldErrors.whatsapp).toEqual(['Ingresá el número con código de país, por ejemplo +54 9 2478 40-7084']);
		expect((await storedSettings()).contact.whatsapp).toBe('5491155550000');
	});
});
