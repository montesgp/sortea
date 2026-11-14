import { randomUUID } from 'node:crypto';
import { and, asc, eq, schema as s } from '@sortea/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminHeaders, createTenant, createTestContext, type TenantFixture, type TestContext } from './helpers';

/**
 * odd/tasks/draw-room.md T4 (S3): platform staff give a person a role in an
 * organization from the console, "Conductor del sorteo" included, change it or
 * disable the membership. Audited, and never without an active owner.
 */
let ctx: TestContext;
let staff: Record<string, string>;
let tenant: TenantFixture;
const platformAdmin = '00000000-0000-4000-8000-00000000c0a2';

const unique = (label: string) => `${label}-${randomUUID().slice(0, 8)}@users.test`;
const addMember = (payload: Record<string, unknown>, as: Record<string, string> = staff, organizationId = tenant.id) =>
	ctx.app.inject({ method: 'POST', url: `/platform/organizations/${organizationId}/members`, headers: as, payload });
const updateMember = (userId: string, payload: Record<string, unknown>, as: Record<string, string> = staff, organizationId = tenant.id) =>
	ctx.app.inject({ method: 'PATCH', url: `/platform/organizations/${organizationId}/members/${userId}`, headers: as, payload });
const members = (organizationId = tenant.id) =>
	ctx.db.withPlatform((db) =>
		db
			.select({ userId: s.organizationMembers.userId, email: s.organizationMembers.email, role: s.organizationMembers.role, status: s.organizationMembers.status })
			.from(s.organizationMembers)
			.where(eq(s.organizationMembers.organizationId, organizationId))
			.orderBy(asc(s.organizationMembers.email))
	);
const memberAudits = (organizationId = tenant.id) =>
	ctx.db.withPlatform((db) =>
		db
			.select({ action: s.auditEvents.action, actorType: s.auditEvents.actorType, actorId: s.auditEvents.actorId, targetId: s.auditEvents.targetId, metadata: s.auditEvents.metadata })
			.from(s.auditEvents)
			.where(and(eq(s.auditEvents.organizationId, organizationId), eq(s.auditEvents.targetType, 'admin_user')))
			.orderBy(asc(s.auditEvents.createdAt), asc(s.auditEvents.id))
	);

beforeAll(async () => {
	ctx = await createTestContext();
	await ctx.db.withPlatform((db) => db.insert(s.platformAdmins).values({ userId: platformAdmin, email: 'members-console@test' }).onConflictDoNothing());
	staff = { 'x-internal-token': ctx.deps.config.INTERNAL_API_TOKEN, authorization: `Bearer ${await ctx.signAdmin(platformAdmin, 'members-console@test')}` };
	tenant = await createTenant(ctx, 'members');
	// Fixture members get their account when they first sign in.
	await adminHeaders(ctx, tenant);
	await adminHeaders(ctx, tenant, tenant.operatorId);
});
afterAll(() => ctx.close());

describe('adding a person to an organization', () => {
	it('creates the account with a temporary password shown once, as draw host, audited', async () => {
		const email = unique('Conductor');
		const response = await addMember({ email, role: 'draw_host' });
		expect(response.statusCode, response.body).toBe(201);
		const body = response.json();
		expect(body.member).toEqual({ userId: expect.any(String), email: email.toLowerCase(), role: 'draw_host', created: true, temporaryPassword: expect.any(String) });
		expect(body.members).toContainEqual({ userId: body.member.userId, email: email.toLowerCase(), alias: null, role: 'draw_host', status: 'active' });
		const [user] = await ctx.db.withPlatform((db) => db.select().from(s.adminUsers).where(eq(s.adminUsers.id, body.member.userId)));
		expect(user!.mustChangePassword).toBe(true);
		expect(user!.passwordHash).not.toContain(body.member.temporaryPassword);
		// Written in one transaction, so both carry the same time: compared by action.
		const audits = (await memberAudits()).filter((event) => event.targetId === body.member.userId).sort((a, b) => a.action.localeCompare(b.action));
		expect(audits).toEqual([
			{ action: 'admin_user.created', actorType: 'platform_admin', actorId: platformAdmin, targetId: body.member.userId, metadata: { platformAdmin: false } },
			{ action: 'organization.member_added', actorType: 'platform_admin', actorId: platformAdmin, targetId: body.member.userId, metadata: { role: 'draw_host' } }
		]);
		expect(JSON.stringify(audits)).not.toContain(body.member.temporaryPassword);
	});

	it('attaches an existing account without a password', async () => {
		const email = unique('existente');
		const created = await ctx.app.inject({ method: 'POST', url: '/platform/users', headers: staff, payload: { email } });
		const userId = created.json().user.id as string;
		const response = await addMember({ email: email.toUpperCase(), role: 'auditor' });
		expect(response.statusCode, response.body).toBe(201);
		expect(response.json().member).toEqual({ userId, email, role: 'auditor', created: false, temporaryPassword: null });
	});

	it('refuses an unknown role, a bad email, a member already there and an unknown organization, changing nothing', async () => {
		const present = unique('presente');
		expect((await addMember({ email: present, role: 'support_agent' })).statusCode).toBe(201);
		const before = await members();
		const audits = await memberAudits();
		expect((await addMember({ email: unique('x'), role: 'superuser' })).statusCode).toBe(400);
		expect((await addMember({ email: 'no-es-email', role: 'draw_host' })).statusCode).toBe(400);
		const again = await addMember({ email: present, role: 'draw_host' });
		expect(again.statusCode).toBe(409);
		expect(again.json().error).toEqual({ code: 'member_exists', message: 'Esa persona ya es miembro de la organización: cambiale el rol desde la lista' });
		expect((await addMember({ email: unique('y'), role: 'draw_host' }, staff, randomUUID())).statusCode).toBe(404);
		expect(await members()).toEqual(before);
		expect(await memberAudits()).toEqual(audits);
	});

	it('is for platform staff only: an organization owner gets 403', async () => {
		const owner = await adminHeaders(ctx, tenant);
		const email = unique('owner-try');
		expect((await addMember({ email, role: 'draw_host' }, owner)).statusCode).toBe(403);
		expect((await members()).map((member) => member.email)).not.toContain(email);
	});
});

describe('changing a member', () => {
	it('changes the role and disables the membership, each change audited', async () => {
		const changed = await updateMember(tenant.operatorId, { role: 'draw_host' });
		expect(changed.statusCode, changed.body).toBe(200);
		expect(changed.json().members).toContainEqual(expect.objectContaining({ userId: tenant.operatorId, role: 'draw_host', status: 'active' }));
		const disabled = await updateMember(tenant.operatorId, { status: 'disabled' });
		expect(disabled.statusCode).toBe(200);
		expect((await members()).find((member) => member.userId === tenant.operatorId)).toMatchObject({ role: 'draw_host', status: 'disabled' });
		// A disabled membership opens nothing in the organization's panel.
		expect((await ctx.app.inject({ method: 'GET', url: '/admin/session', headers: await adminHeaders(ctx, tenant, tenant.operatorId) })).statusCode).toBe(403);
		const updates = (await memberAudits()).filter((event) => event.action === 'organization.member_updated' && event.targetId === tenant.operatorId);
		expect(updates.map((event) => event.metadata)).toEqual([
			{ from: { role: 'campaign_operator', status: 'active' }, to: { role: 'draw_host', status: 'active' } },
			{ from: { role: 'draw_host', status: 'active' }, to: { role: 'draw_host', status: 'disabled' } }
		]);
		expect((await updateMember(tenant.operatorId, { status: 'active', role: 'campaign_operator' })).statusCode).toBe(200);
		expect((await members()).find((member) => member.userId === tenant.operatorId)).toMatchObject({ role: 'campaign_operator', status: 'active' });
	});

	it('never leaves the organization without an active owner', async () => {
		const before = await members();
		for (const change of [{ role: 'draw_host' }, { status: 'disabled' }]) {
			const refused = await updateMember(tenant.ownerId, change);
			expect(refused.statusCode).toBe(409);
			expect(refused.json().error).toEqual({ code: 'last_owner', message: 'La organización tiene que conservar al menos un dueño activo' });
		}
		expect(await members()).toEqual(before);
		// With a second owner, the first one can change.
		const second = (await addMember({ email: unique('segundo-duenio'), role: 'org_owner' })).json().member.userId as string;
		expect((await updateMember(tenant.ownerId, { role: 'org_admin' })).statusCode).toBe(200);
		const refused = await updateMember(second, { status: 'disabled' });
		expect(refused.statusCode).toBe(409);
		expect((await updateMember(tenant.ownerId, { role: 'org_owner' })).statusCode).toBe(200);
	});

	it('refuses an empty change, an unknown role or member, and organization staff', async () => {
		expect((await updateMember(tenant.operatorId, {})).statusCode).toBe(400);
		expect((await updateMember(tenant.operatorId, { role: 'superuser' })).statusCode).toBe(400);
		expect((await updateMember(tenant.operatorId, { status: 'invited' })).statusCode).toBe(400);
		expect((await updateMember(randomUUID(), { role: 'auditor' })).statusCode).toBe(404);
		const before = await members();
		expect((await updateMember(tenant.operatorId, { role: 'org_owner' }, await adminHeaders(ctx, tenant))).statusCode).toBe(403);
		expect(await members()).toEqual(before);
	});
});
