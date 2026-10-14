import { and, eq, schema as s } from '@sortea/db';
import type { FastifyRequest } from 'fastify';
import type { AdminIdentity } from './admin-auth';
import { ApiError, forbidden } from './errors';
import { can, permissionsFor, type ActingRole, type Permission } from './rbac';
import { requireTenant, type Tenant } from './tenant';

export interface AdminContext {
	readonly identity: AdminIdentity;
	readonly tenant: Tenant;
	readonly role: ActingRole;
	readonly permissions: readonly Permission[];
	assert(permission: Permission): void;
}

async function authenticate(request: FastifyRequest): Promise<AdminIdentity> {
	const header = request.headers.authorization;
	const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
	if (!token) throw new ApiError(401, 'unauthenticated', 'Iniciá sesión para continuar');
	const identity = await request.server.deps.verifyAdminToken(token);
	if (!identity) throw new ApiError(401, 'unauthenticated', 'Tu sesión venció. Iniciá sesión de nuevo');
	if (request.server.deps.config.REQUIRE_ADMIN_MFA && identity.aal !== 'aal2') {
		throw new ApiError(403, 'mfa_required', 'Completá la verificación en dos pasos para continuar');
	}
	return identity;
}

async function isPlatformAdmin(request: FastifyRequest, userId: string): Promise<boolean> {
	const rows = await request.server.deps.db.withPlatform((db) =>
		db.select({ userId: s.platformAdmins.userId }).from(s.platformAdmins).where(eq(s.platformAdmins.userId, userId))
	);
	return rows.length > 0;
}

/** Admin of the organization that owns the requested hostname. */
export async function requireAdmin(request: FastifyRequest, permission?: Permission): Promise<AdminContext> {
	const identity = await authenticate(request);
	const tenant = await requireTenant(request);
	const [membership] = await request.server.deps.db.withTenant(tenant.id, (tx) =>
		tx
			.select({ role: s.organizationMembers.role })
			.from(s.organizationMembers)
			.where(and(eq(s.organizationMembers.userId, identity.userId), eq(s.organizationMembers.status, 'active')))
	);
	let role: ActingRole | null = membership?.role ?? null;
	if (!role && (await isPlatformAdmin(request, identity.userId))) role = 'platform_superadmin';
	if (!role) throw forbidden('Tu usuario no tiene acceso a esta organización');

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
