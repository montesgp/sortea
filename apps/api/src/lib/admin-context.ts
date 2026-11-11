import { and, eq, schema as s } from '@sortea/db';
import type { FastifyRequest } from 'fastify';
import { lookupSession, type AdminIdentity } from './admin-auth';
import { ApiError, forbidden } from './errors';
import { can, permissionsFor, type ActingRole, type Permission } from './rbac';
import { resolveTenant, type Tenant } from './tenant';

export interface AdminContext {
	readonly identity: AdminIdentity;
	readonly tenant: Tenant;
	readonly role: ActingRole;
	readonly permissions: readonly Permission[];
	assert(permission: Permission): void;
}

/**
 * The session behind the bearer token, without the panel's gates: for the
 * sign-in steps themselves (second factor, password change, sign-out).
 */
export async function requireSession(request: FastifyRequest): Promise<AdminIdentity> {
	const header = request.headers.authorization;
	const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
	if (!token) throw new ApiError(401, 'unauthenticated', 'Iniciá sesión para continuar');
	const { db, now } = request.server.deps;
	const identity = await db.withPlatform((platform) => lookupSession(platform, token, now()));
	if (!identity) throw new ApiError(401, 'unauthenticated', 'Tu sesión venció. Iniciá sesión de nuevo');
	return identity;
}

const mfaRequired = () => new ApiError(403, 'mfa_required', 'Completá la verificación en dos pasos para continuar');

/**
 * A session that may use the panel. With REQUIRE_ADMIN_MFA a user who has an
 * authenticator app confirms a code first, then replaces a temporary password,
 * and a user without one replaces it and then sets the app up.
 */
async function authenticate(request: FastifyRequest): Promise<AdminIdentity> {
	const identity = await requireSession(request);
	const mfa = request.server.deps.config.REQUIRE_ADMIN_MFA && identity.assurance !== 'mfa';
	if (mfa && identity.totpConfirmed) throw mfaRequired();
	if (identity.mustChangePassword) throw new ApiError(403, 'password_change_required', 'Elegí una contraseña nueva para continuar');
	if (mfa) throw mfaRequired();
	return identity;
}

async function isPlatformAdmin(request: FastifyRequest, userId: string): Promise<boolean> {
	const rows = await request.server.deps.db.withPlatform((db) =>
		db.select({ userId: s.platformAdmins.userId }).from(s.platformAdmins).where(eq(s.platformAdmins.userId, userId))
	);
	return rows.length > 0;
}

/**
 * Admin of the organization that owns the requested hostname. A suspended
 * organization's panel is open to platform staff only, so the console that
 * suspended it can reactivate it from the same domain (S13).
 */
export async function requireAdmin(request: FastifyRequest, permission?: Permission): Promise<AdminContext> {
	const identity = await authenticate(request);
	const tenant = await resolveTenant(request);
	if (tenant.status !== 'active') {
		if (!(await isPlatformAdmin(request, identity.userId))) {
			throw new ApiError(403, 'organization_suspended', 'La organización está suspendida. Escribile al equipo de plataforma para reactivarla.');
		}
		return adminContext(identity, tenant, 'platform_superadmin', permission);
	}
	const [membership] = await request.server.deps.db.withTenant(tenant.id, (tx) =>
		tx
			.select({ role: s.organizationMembers.role })
			.from(s.organizationMembers)
			.where(and(eq(s.organizationMembers.userId, identity.userId), eq(s.organizationMembers.status, 'active')))
	);
	let role: ActingRole | null = membership?.role ?? null;
	if (!role && (await isPlatformAdmin(request, identity.userId))) role = 'platform_superadmin';
	if (!role) throw forbidden('Tu usuario no tiene acceso a esta organización');
	return adminContext(identity, tenant, role, permission);
}

function adminContext(identity: AdminIdentity, tenant: Tenant, role: ActingRole, permission?: Permission): AdminContext {
	const context: AdminContext = {
		identity,
		tenant,
		role,
		permissions: permissionsFor(role),
		assert(needed) {
			if (!can(role, needed)) throw forbidden();
		}
	};
	if (permission) context.assert(permission);
	return context;
}

export async function requirePlatformAdmin(request: FastifyRequest): Promise<AdminIdentity> {
	const identity = await authenticate(request);
	if (!(await isPlatformAdmin(request, identity.userId))) throw forbidden('Solo el equipo de plataforma puede hacer esto');
	return identity;
}

export function actorType(context: AdminContext): 'admin' | 'platform_admin' {
	return context.role === 'platform_superadmin' ? 'platform_admin' : 'admin';
}
