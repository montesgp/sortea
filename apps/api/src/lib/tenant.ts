import { eq, schema as s, type DatabaseHandle, type OrganizationSettings } from '@sortea/db';
import { resolveTheme, type ThemeOverrides } from '@sortea/domain';
import type { FastifyRequest } from 'fastify';
import { ApiError } from './errors';

export interface Tenant {
	readonly id: string;
	readonly slug: string;
	readonly name: string;
	readonly locale: string;
	readonly timezone: string;
	readonly currency: string;
	readonly orderPrefix: string;
	readonly settings: OrganizationSettings;
	readonly primaryHostname: string | null;
	readonly themeOverrides: ThemeOverrides;
}

/**
 * Hostname → organization (FR-ORG-06). The hostname comes from the web tier,
 * which reads the real Host header and authenticates to the API with the
 * internal token, so a browser can never choose its tenant by parameter.
 */
export function createTenantResolver(db: DatabaseHandle, ttlMs = 30_000) {
	const cache = new Map<string, { tenant: Tenant | null; expires: number }>();

	async function load(hostname: string): Promise<Tenant | null> {
		return db.withPlatform(async (database) => {
			const [row] = await database
				.select({ org: s.organizations })
				.from(s.organizationDomains)
				.innerJoin(s.organizations, eq(s.organizations.id, s.organizationDomains.organizationId))
				.where(eq(s.organizationDomains.hostname, hostname));
			if (!row || row.org.status !== 'active') return null;
			const domains = await database.select().from(s.organizationDomains).where(eq(s.organizationDomains.organizationId, row.org.id));
			const themes = await database.select().from(s.organizationThemes).where(eq(s.organizationThemes.organizationId, row.org.id));
			const theme = themes.find((candidate) => candidate.isActive && candidate.campaignId === null);
			return {
				id: row.org.id,
				slug: row.org.slug,
				name: row.org.name,
				locale: row.org.locale,
				timezone: row.org.timezone,
				currency: row.org.currency,
				orderPrefix: row.org.orderPrefix,
				settings: row.org.settings,
				primaryHostname: domains.find((domain) => domain.isPrimary)?.hostname ?? null,
				themeOverrides: theme?.tokens ?? {}
			};
		});
	}

	return {
		async resolve(hostname: string): Promise<Tenant | null> {
			const key = normalizeHostname(hostname);
			const hit = cache.get(key);
			if (hit && hit.expires > Date.now()) return hit.tenant;
			const tenant = await load(key);
			cache.set(key, { tenant, expires: Date.now() + ttlMs });
			return tenant;
		},
		invalidate() {
			cache.clear();
		}
	};
}

export type TenantResolver = ReturnType<typeof createTenantResolver>;

export function normalizeHostname(value: string): string {
	return value.trim().toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
}

export async function requireTenant(request: FastifyRequest): Promise<Tenant> {
	const host = request.headers['x-tenant-host'];
	if (typeof host !== 'string' || !host) throw new ApiError(400, 'missing_tenant', 'Falta el contexto de organización');
	const tenant = await request.server.tenants.resolve(host);
	if (!tenant) throw new ApiError(404, 'unknown_tenant', 'Sitio no encontrado');
	return tenant;
}

/** Public origin for links in emails and payment redirects. */
export function tenantOrigin(tenant: Tenant, fallback: string): string {
	if (!tenant.primaryHostname || ['localhost', '127.0.0.1'].includes(tenant.primaryHostname) || tenant.primaryHostname.endsWith('.localhost')) {
		const url = new URL(fallback);
		if (tenant.primaryHostname?.endsWith('.localhost')) url.hostname = tenant.primaryHostname;
		return url.origin;
	}
	return `https://${tenant.primaryHostname}`;
}

export function resolvedTheme(tenant: Tenant) {
	return resolveTheme(tenant.themeOverrides);
}
