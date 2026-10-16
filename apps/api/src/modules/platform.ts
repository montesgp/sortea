import { and, asc, count, eq, ne, schema as s, type Database } from '@sortea/db';
import { resolveTheme, themeOverridesSchema, themeToCss } from '@sortea/domain';
import { maskSecret, sealSecret } from '@sortea/domain/server';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePlatformAdmin } from '../lib/admin-context';
import { audit } from '../lib/audit';
import { ApiError, notFound, parse } from '../lib/errors';
import { normalizeHostname } from '../lib/tenant';
import { integrationOwner, loadMercadoPago } from '../payments/integrations';
import { ProviderError } from '../payments/provider';

const idParams = z.object({ id: z.uuid() });
const hostname = z
	.string()
	.trim()
	.toLowerCase()
	.regex(/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/, 'Dominio inválido');

const createOrganization = z.object({
	name: z.string().trim().min(2).max(80),
	slug: z.string().trim().regex(/^[a-z0-9-]{2,40}$/),
	orderPrefix: z.string().trim().regex(/^[A-Z]{2,4}$/),
	hostname,
	ownerUserId: z.uuid().optional(),
	ownerEmail: z.email().optional()
});

const mercadoPagoBody = z.object({
	mode: z.enum(['sandbox', 'production']),
	accessToken: z.string().trim().regex(/^(APP_USR|TEST)-[A-Za-z0-9-]{10,200}$/, 'Access token inválido'),
	webhookSecret: z.string().trim().min(16).max(200),
	publicKey: z.string().trim().max(200).optional()
});

/**
 * Platform administration (platform_superadmin). The only module that works
 * across organizations, so every call is authenticated as platform staff and
 * audited. Secrets are write-only: responses carry a masked hint, never the
 * value (FR-ORG-02, AC-05).
 */
export async function platformRoutes(app: FastifyInstance) {
	const { deps } = app;

	app.get('/platform/organizations', async (request) => {
		await requirePlatformAdmin(request);
		return deps.db.withPlatform(async (db) => {
			const organizations = await db.select().from(s.organizations).orderBy(asc(s.organizations.createdAt));
			const [domains, members, integrations] = await Promise.all([
				db.select().from(s.organizationDomains),
				db.select({ organizationId: s.organizationMembers.organizationId, value: count() }).from(s.organizationMembers).groupBy(s.organizationMembers.organizationId),
				db.select().from(s.organizationIntegrations).where(eq(s.organizationIntegrations.isActive, true))
			]);
			return {
				organizations: organizations.map((org) => ({
					id: org.id,
					name: org.name,
					slug: org.slug,
					status: org.status,
					domains: domains.filter((domain) => domain.organizationId === org.id).map((domain) => domain.hostname),
					members: members.find((row) => row.organizationId === org.id)?.value ?? 0,
					payments: integrations
						.filter((integration) => integration.organizationId === org.id && integration.provider === 'mercadopago')
						.map((integration) => ({ mode: integration.mode, status: integration.status }))[0] ?? null
				}))
			};
		});
	});

	app.get('/platform/organizations/:id', async (request) => {
		await requirePlatformAdmin(request);
		const { id } = parse(idParams, request.params);
		return deps.db.withPlatform((db) => organizationDetail(db, id));
	});

	app.post('/platform/organizations', async (request, reply) => {
		const identity = await requirePlatformAdmin(request);
		const body = parse(createOrganization, request.body);
		const created = await deps.db.withPlatform((db) =>
			db.transaction(async (tx) => {
				const [taken] = await tx.select({ id: s.organizationDomains.id }).from(s.organizationDomains).where(eq(s.organizationDomains.hostname, normalizeHostname(body.hostname)));
				if (taken) throw new ApiError(409, 'hostname_taken', 'Ese dominio ya pertenece a otra organización');
				const [org] = await tx
					.insert(s.organizations)
					.values({
						name: body.name,
						slug: body.slug,
						orderPrefix: body.orderPrefix,
						settings: {
							contact: {},
							social: {},
							delivery: { pickupEnabled: false, shippingEnabled: false, shippingFeeMinor: 0 },
							legal: { termsVersion: 'pending', privacyVersion: 'pending' }
						}
					})
					.onConflictDoNothing({ target: s.organizations.slug })
					.returning({ id: s.organizations.id });
				if (!org) throw new ApiError(409, 'slug_taken', 'Ese identificador ya existe');
				await tx.insert(s.organizationDomains).values({ organizationId: org.id, hostname: normalizeHostname(body.hostname), isPrimary: true });
				await tx.insert(s.organizationThemes).values({ organizationId: org.id, tokens: {} });
				if (body.ownerUserId && body.ownerEmail) {
					await tx.insert(s.organizationMembers).values({ organizationId: org.id, userId: body.ownerUserId, email: body.ownerEmail, role: 'org_owner' });
				}
				await audit(tx, { organizationId: org.id, actorType: 'platform_admin', actorId: identity.userId, action: 'organization.created', targetType: 'organization', targetId: org.id });
				return org.id;
			})
		);
		app.tenants.invalidate();
		return reply.status(201).send(await deps.db.withPlatform((db) => organizationDetail(db, created)));
	});

	app.post('/platform/organizations/:id/status', async (request) => {
		const identity = await requirePlatformAdmin(request);
		const { id } = parse(idParams, request.params);
		const { status } = parse(z.object({ status: z.enum(['active', 'suspended']) }), request.body);
		await deps.db.withPlatform(async (db) => {
			const updated = await db.update(s.organizations).set({ status, updatedAt: deps.now() }).where(eq(s.organizations.id, id)).returning({ id: s.organizations.id });
			if (!updated.length) throw notFound('Organización');
			await audit(db, { organizationId: id, actorType: 'platform_admin', actorId: identity.userId, action: `organization.${status}`, targetType: 'organization', targetId: id });
		});
		app.tenants.invalidate();
		return deps.db.withPlatform((db) => organizationDetail(db, id));
	});

	app.post('/platform/organizations/:id/domains', async (request) => {
		const identity = await requirePlatformAdmin(request);
		const { id } = parse(idParams, request.params);
		const body = parse(z.object({ hostname, isPrimary: z.boolean().default(false) }), request.body);
		await deps.db.withPlatform((db) =>
			db.transaction(async (tx) => {
				const [taken] = await tx.select().from(s.organizationDomains).where(eq(s.organizationDomains.hostname, body.hostname));
				if (taken) throw new ApiError(409, 'hostname_taken', 'Ese dominio ya está asignado');
				if (body.isPrimary) await tx.update(s.organizationDomains).set({ isPrimary: false }).where(eq(s.organizationDomains.organizationId, id));
				await tx.insert(s.organizationDomains).values({ organizationId: id, hostname: body.hostname, isPrimary: body.isPrimary });
				await audit(tx, { organizationId: id, actorType: 'platform_admin', actorId: identity.userId, action: 'organization.domain_added', targetType: 'organization', targetId: id, metadata: { hostname: body.hostname } });
			})
		);
		app.tenants.invalidate();
		return deps.db.withPlatform((db) => organizationDetail(db, id));
	});

	app.put('/platform/organizations/:id/theme', async (request) => {
		const identity = await requirePlatformAdmin(request);
		const { id } = parse(idParams, request.params);
		const tokens = parse(themeOverridesSchema, (request.body as { tokens?: unknown } | null)?.tokens);
		const resolved = resolveTheme(tokens);
		await deps.db.withPlatform((db) =>
			db.transaction(async (tx) => {
				const [current] = await tx
					.select()
					.from(s.organizationThemes)
					.where(and(eq(s.organizationThemes.organizationId, id), eq(s.organizationThemes.isActive, true)));
				await tx.update(s.organizationThemes).set({ isActive: false }).where(eq(s.organizationThemes.organizationId, id));
				await tx.insert(s.organizationThemes).values({ organizationId: id, tokens, version: (current?.version ?? 0) + 1 });
				await audit(tx, { organizationId: id, actorType: 'platform_admin', actorId: identity.userId, action: 'organization.theme_updated', targetType: 'organization', targetId: id, metadata: { contrastIssues: resolved.issues.length } });
			})
		);
		app.tenants.invalidate();
		return { issues: resolved.issues, css: themeToCss(resolved.tokens) };
	});

	app.put('/platform/organizations/:id/integrations/mercadopago', async (request) => {
		const identity = await requirePlatformAdmin(request);
		const { id } = parse(idParams, request.params);
		const body = parse(mercadoPagoBody, request.body);
		if (body.mode === 'production' && !body.accessToken.startsWith('APP_USR-')) {
			throw new ApiError(400, 'invalid_token', 'Producción requiere un access token APP_USR');
		}
		await deps.db.withPlatform((db) =>
			db.transaction(async (tx) => {
				const [org] = await tx.select({ id: s.organizations.id }).from(s.organizations).where(eq(s.organizations.id, id));
				if (!org) throw notFound('Organización');
				const [existing] = await tx
					.select()
					.from(s.organizationIntegrations)
					.where(and(eq(s.organizationIntegrations.organizationId, id), eq(s.organizationIntegrations.provider, 'mercadopago'), eq(s.organizationIntegrations.mode, body.mode)));
				const publicConfig = { ...(body.publicKey ? { publicKey: body.publicKey } : {}) };
				const integrationId = existing?.id ?? (
					await tx
						.insert(s.organizationIntegrations)
						.values({ organizationId: id, provider: 'mercadopago', mode: body.mode, sealedSecrets: 'pending', keyVersion: deps.keyRing.current, secretHint: '' })
						.returning({ id: s.organizationIntegrations.id })
				)[0]!.id;
				const sealed = sealSecret(deps.keyRing, JSON.stringify({ accessToken: body.accessToken, webhookSecret: body.webhookSecret }), integrationOwner(id, integrationId));
				await tx
					.update(s.organizationIntegrations)
					.set({
						sealedSecrets: sealed,
						keyVersion: deps.keyRing.current,
						secretHint: maskSecret(body.accessToken),
						publicConfig,
						status: 'configured',
						isActive: true,
						lastError: null,
						lastVerifiedAt: null,
						version: (existing?.version ?? 0) + 1,
						updatedBy: identity.userId,
						updatedAt: deps.now()
					})
					.where(eq(s.organizationIntegrations.id, integrationId));
				// One active Mercado Pago account per organization.
				await tx
					.update(s.organizationIntegrations)
					.set({ isActive: false })
					.where(and(eq(s.organizationIntegrations.organizationId, id), eq(s.organizationIntegrations.provider, 'mercadopago'), ne(s.organizationIntegrations.id, integrationId)));
				await audit(tx, {
					organizationId: id,
					actorType: 'platform_admin',
					actorId: identity.userId,
					action: 'integration.mercadopago_updated',
					targetType: 'integration',
					targetId: integrationId,
					metadata: { mode: body.mode, version: (existing?.version ?? 0) + 1 }
				});
			})
		);
		return deps.db.withPlatform((db) => organizationDetail(db, id));
	});

	/** Calls the provider with the stored credentials and records the merchant id used to validate payments. */
	app.post('/platform/organizations/:id/integrations/mercadopago/verify', async (request) => {
		const identity = await requirePlatformAdmin(request);
		const { id } = parse(idParams, request.params);
		const integration = await deps.db.withTenant(id, (tx) => loadMercadoPago(tx, id, deps.keyRing));
		if (!integration) throw notFound('Integración');
		let result: { status: 'verified' | 'error'; collectorId?: string; error?: string };
		try {
			const account = await deps.payments.verifyAccount(integration.credentials);
			result = { status: 'verified', collectorId: account.collectorId };
		} catch (error) {
			result = { status: 'error', error: error instanceof ProviderError ? `HTTP ${error.status ?? 'sin respuesta'}` : 'Error de conexión' };
		}
		await deps.db.withPlatform(async (db) => {
			const [row] = await db.select().from(s.organizationIntegrations).where(eq(s.organizationIntegrations.id, integration.id));
			await db
				.update(s.organizationIntegrations)
				.set({
					status: result.status,
					lastVerifiedAt: deps.now(),
					lastError: result.error ?? null,
					publicConfig: result.collectorId ? { ...row!.publicConfig, collectorId: result.collectorId } : row!.publicConfig
				})
				.where(eq(s.organizationIntegrations.id, integration.id));
			await audit(db, { organizationId: id, actorType: 'platform_admin', actorId: identity.userId, action: 'integration.mercadopago_verified', targetType: 'integration', targetId: integration.id, metadata: { status: result.status } });
		});
		return deps.db.withPlatform((db) => organizationDetail(db, id));
	});
}

async function organizationDetail(db: Database, id: string) {
	const [org] = await db.select().from(s.organizations).where(eq(s.organizations.id, id));
	if (!org) throw notFound('Organización');
	const [domains, members, integrations, themes] = await Promise.all([
		db.select().from(s.organizationDomains).where(eq(s.organizationDomains.organizationId, id)),
		db.select().from(s.organizationMembers).where(eq(s.organizationMembers.organizationId, id)),
		db.select().from(s.organizationIntegrations).where(eq(s.organizationIntegrations.organizationId, id)),
		db.select().from(s.organizationThemes).where(and(eq(s.organizationThemes.organizationId, id), eq(s.organizationThemes.isActive, true)))
	]);
	return {
		id: org.id,
		name: org.name,
		slug: org.slug,
		status: org.status,
		orderPrefix: org.orderPrefix,
		locale: org.locale,
		timezone: org.timezone,
		currency: org.currency,
		domains: domains.map((domain) => ({ hostname: domain.hostname, isPrimary: domain.isPrimary, verifiedAt: domain.verifiedAt })),
		members: members.map((member) => ({ email: member.email, role: member.role, status: member.status })),
		// Write-only secrets: only the hint, mode and health ever leave the API.
		integrations: integrations.map((integration) => ({
			provider: integration.provider,
			mode: integration.mode,
			status: integration.status,
			isActive: integration.isActive,
			secretHint: integration.secretHint,
			collectorId: integration.publicConfig.collectorId ?? null,
			simulator: integration.publicConfig.simulator === 'true',
			version: integration.version,
			keyVersion: integration.keyVersion,
			lastVerifiedAt: integration.lastVerifiedAt,
			lastError: integration.lastError
		})),
		theme: themes[0]?.tokens ?? {}
	};
}
