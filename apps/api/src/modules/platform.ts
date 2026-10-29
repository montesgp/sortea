import { and, asc, count, desc, eq, gt, inArray, ne, schema as s, type Database, type Executor } from '@sortea/db';
import { publicContact, publicSocial, resolveTheme, socialLinksSchema, themeOverridesSchema, themeToCss, whatsappNumberSchema } from '@sortea/domain';
import { maskSecret, sealSecret } from '@sortea/domain/server';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requirePlatformAdmin } from '../lib/admin-context';
import { audit } from '../lib/audit';
import { saveSocial, saveWhatsApp } from '../lib/organization-contact';
import { ApiError, notFound, parse } from '../lib/errors';
import { normalizeHostname } from '../lib/tenant';
import { integrationOwner, loadMercadoPago, loadMercadoPagoAccounts } from '../payments/integrations';
import { ProviderError } from '../payments/provider';

const idParams = z.object({ id: z.uuid() });
const integrationParams = z.object({ id: z.uuid(), integrationId: z.uuid() });
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
		return deps.db.withPlatform((db) => organizationDetail(db, id, deps.config.API_PUBLIC_URL));
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
		return reply.status(201).send(await deps.db.withPlatform((db) => organizationDetail(db, created, deps.config.API_PUBLIC_URL)));
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
		return deps.db.withPlatform((db) => organizationDetail(db, id, deps.config.API_PUBLIC_URL));
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
		return deps.db.withPlatform((db) => organizationDetail(db, id, deps.config.API_PUBLIC_URL));
	});

	/** Public contact channels; the WhatsApp number is stored as the digits wa.me expects (S5). */
	app.put('/platform/organizations/:id/contact', async (request) => {
		const identity = await requirePlatformAdmin(request);
		const { id } = parse(idParams, request.params);
		const { whatsapp } = parse(z.object({ whatsapp: whatsappNumberSchema }), request.body);
		await deps.db.withPlatform((db) =>
			db.transaction(async (tx) => {
				await saveWhatsApp(tx, id, whatsapp, deps.now());
				await audit(tx, { organizationId: id, actorType: 'platform_admin', actorId: identity.userId, action: 'organization.contact_updated', targetType: 'organization', targetId: id, metadata: { whatsapp: Boolean(whatsapp) } });
			})
		);
		app.tenants.invalidate();
		return deps.db.withPlatform((db) => organizationDetail(db, id, deps.config.API_PUBLIC_URL));
	});

	/** Social links of the organization's public site (S8, 2026-10-18). */
	app.put('/platform/organizations/:id/social', async (request) => {
		const identity = await requirePlatformAdmin(request);
		const { id } = parse(idParams, request.params);
		const links = parse(socialLinksSchema, request.body);
		await deps.db.withPlatform((db) =>
			db.transaction(async (tx) => {
				const saved = await saveSocial(tx, id, links, deps.now());
				await audit(tx, { organizationId: id, actorType: 'platform_admin', actorId: identity.userId, action: 'organization.social_updated', targetType: 'organization', targetId: id, metadata: { networks: Object.keys(saved) } });
			})
		);
		app.tenants.invalidate();
		return deps.db.withPlatform((db) => organizationDetail(db, id, deps.config.API_PUBLIC_URL));
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

	/**
	 * Connecting is one step: the credentials are checked with Mercado Pago
	 * before anything is stored, and the merchant (collector id) they belong to
	 * is kept to validate every payment. Refused credentials store nothing.
	 *
	 * Another account can be connected at any time, even while orders await
	 * payment: the organization row lock orders this against every checkout, so
	 * an order is created either with the previous account or with the new one,
	 * and keeps it (S1, S2).
	 */
	app.put('/platform/organizations/:id/integrations/mercadopago', async (request) => {
		const identity = await requirePlatformAdmin(request);
		const { id } = parse(idParams, request.params);
		const body = parse(mercadoPagoBody, request.body);
		if (body.mode === 'production' && !body.accessToken.startsWith('APP_USR-')) {
			throw new ApiError(400, 'invalid_token', 'Producción requiere un access token APP_USR');
		}
		const [known] = await deps.db.withPlatform((db) => db.select({ id: s.organizations.id }).from(s.organizations).where(eq(s.organizations.id, id)));
		if (!known) throw notFound('Organización');
		const { collectorId } = await checkAccount(
			request,
			id,
			() => deps.payments.verifyAccount({ accessToken: body.accessToken, webhookSecret: body.webhookSecret }),
			(status) => `Mercado Pago rechazó las credenciales (HTTP ${status}). Revisá el access token y el entorno elegido.`
		);
		await deps.db.withPlatform((db) =>
			db.transaction(async (tx) => {
				const rows = await lockAccounts(tx, id);
				const active = rows.find((row) => row.isActive);
				// An account is a merchant in a mode: the same pair again is a credential rotation
				// of that account; anything else is another account (S4).
				const existing = rows.find((row) => row.mode === body.mode && row.publicConfig.collectorId === collectorId);
				const publicConfig = { ...(body.publicKey ? { publicKey: body.publicKey } : {}), collectorId };
				const integrationId = existing?.id ?? (
					await tx
						.insert(s.organizationIntegrations)
						.values({ organizationId: id, provider: 'mercadopago', mode: body.mode, sealedSecrets: 'pending', keyVersion: deps.keyRing.current, secretHint: '', isActive: false })
						.returning({ id: s.organizationIntegrations.id })
				)[0]!.id;
				await retireActive(tx, id, integrationId, deps.now());
				const sealed = sealSecret(deps.keyRing, JSON.stringify({ accessToken: body.accessToken, webhookSecret: body.webhookSecret }), integrationOwner(id, integrationId));
				await tx
					.update(s.organizationIntegrations)
					.set({
						sealedSecrets: sealed,
						keyVersion: deps.keyRing.current,
						secretHint: maskSecret(body.accessToken),
						publicConfig,
						status: 'verified',
						isActive: true,
						retiredAt: null,
						lastError: null,
						lastVerifiedAt: deps.now(),
						version: (existing?.version ?? 0) + 1,
						updatedBy: identity.userId,
						updatedAt: deps.now()
					})
					.where(eq(s.organizationIntegrations.id, integrationId));
				const switched = active && active.id !== integrationId ? { retiredIntegrationId: active.id, previousCollectorId: active.publicConfig.collectorId ?? null } : {};
				await audit(tx, {
					organizationId: id,
					actorType: 'platform_admin',
					actorId: identity.userId,
					action: 'integration.mercadopago_updated',
					targetType: 'integration',
					targetId: integrationId,
					metadata: { mode: body.mode, version: (existing?.version ?? 0) + 1, collectorId, ...switched }
				});
			})
		);
		return deps.db.withPlatform((db) => organizationDetail(db, id, deps.config.API_PUBLIC_URL));
	});

	/**
	 * Makes a previous account the active one again, with its stored credentials
	 * (S6). Mercado Pago checks them first, and they must still belong to the
	 * same merchant; otherwise nothing changes. Like a switch, it holds the
	 * organization row, so each checkout ends on one account or the other.
	 * Reactivating the active account is refused with 409 (already_active).
	 */
	app.post('/platform/organizations/:id/integrations/mercadopago/:integrationId/activate', async (request) => {
		const identity = await requirePlatformAdmin(request);
		const { id, integrationId } = parse(integrationParams, request.params);
		const accounts = await deps.db.withTenant(id, (tx) => loadMercadoPagoAccounts(tx, id, deps.keyRing));
		const account = accounts.find((candidate) => candidate.id === integrationId);
		if (!account) throw notFound('Cuenta');
		if (account.isActive) throw alreadyActive();
		const { collectorId } = await checkAccount(
			request,
			id,
			() => deps.payments.verifyAccount(account.credentials),
			(status) =>
				`Mercado Pago rechazó las credenciales guardadas de esta cuenta (HTTP ${status}). Para volver a usarla, conectala de nuevo con credenciales nuevas en «Cambiar de cuenta».`
		);
		if (collectorId !== account.collectorId) {
			throw new ApiError(
				409,
				'collector_mismatch',
				`Las credenciales guardadas responden por otra cuenta de Mercado Pago (${collectorId}), no por la cuenta ${account.collectorId ?? 'sin identificar'}. Para usarla, conectala de nuevo en «Cambiar de cuenta».`
			);
		}
		await deps.db.withPlatform((db) =>
			db.transaction(async (tx) => {
				const rows = await lockAccounts(tx, id);
				// Read again under the lock: a switch or a disconnect may have run since.
				const row = rows.find((candidate) => candidate.id === integrationId);
				if (!row) throw notFound('Cuenta');
				if (row.isActive) throw alreadyActive();
				const active = rows.find((candidate) => candidate.isActive);
				await retireActive(tx, id, integrationId, deps.now());
				await tx
					.update(s.organizationIntegrations)
					.set({
						status: 'verified',
						isActive: true,
						retiredAt: null,
						lastError: null,
						lastVerifiedAt: deps.now(),
						updatedBy: identity.userId,
						updatedAt: deps.now()
					})
					.where(eq(s.organizationIntegrations.id, integrationId));
				await audit(tx, {
					organizationId: id,
					actorType: 'platform_admin',
					actorId: identity.userId,
					action: 'integration.mercadopago_reactivated',
					targetType: 'integration',
					targetId: integrationId,
					metadata: {
						mode: row.mode,
						collectorId,
						...(active ? { retiredIntegrationId: active.id, previousCollectorId: active.publicConfig.collectorId ?? null } : {})
					}
				});
			})
		);
		return deps.db.withPlatform((db) => organizationDetail(db, id, deps.config.API_PUBLIC_URL));
	});

	/**
	 * Disconnects the organization's Mercado Pago accounts, the active one and the
	 * previous ones: their sealed credentials are deleted and the checkout stops
	 * taking payments. Refused while any of them has payments in progress, whose
	 * webhooks need the account's secret.
	 */
	app.delete('/platform/organizations/:id/integrations/mercadopago', async (request) => {
		const identity = await requirePlatformAdmin(request);
		const { id } = parse(idParams, request.params);
		await deps.db.withPlatform((db) =>
			db.transaction(async (tx) => {
				const [org] = await tx.select({ id: s.organizations.id }).from(s.organizations).where(eq(s.organizations.id, id)).for('update');
				if (!org) throw notFound('Organización');
				const rows = await tx
					.select()
					.from(s.organizationIntegrations)
					.where(and(eq(s.organizationIntegrations.organizationId, id), eq(s.organizationIntegrations.provider, 'mercadopago')));
				if (rows.length === 0) throw notFound('Integración');
				await assertNoPaymentsInProgress(tx, id, deps.now());
				await tx.delete(s.organizationIntegrations).where(and(eq(s.organizationIntegrations.organizationId, id), eq(s.organizationIntegrations.provider, 'mercadopago')));
				const active = rows.find((row) => row.isActive) ?? rows[0]!;
				await audit(tx, {
					organizationId: id,
					actorType: 'platform_admin',
					actorId: identity.userId,
					action: 'integration.mercadopago_disconnected',
					targetType: 'integration',
					targetId: active.id,
					metadata: { modes: rows.map((row) => row.mode), collectorId: active.publicConfig.collectorId ?? null }
				});
			})
		);
		return deps.db.withPlatform((db) => organizationDetail(db, id, deps.config.API_PUBLIC_URL));
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
		return deps.db.withPlatform((db) => organizationDetail(db, id, deps.config.API_PUBLIC_URL));
	});
}

async function organizationDetail(db: Database, id: string, apiPublicUrl: string) {
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
		contact: publicContact(org.settings.contact),
		social: publicSocial(org.settings.social),
		domains: domains.map((domain) => ({ hostname: domain.hostname, isPrimary: domain.isPrimary, verifiedAt: domain.verifiedAt })),
		members: members.map((member) => ({ email: member.email, role: member.role, status: member.status })),
		// Write-only secrets: only the hint, mode and health ever leave the API.
		integrations: integrations.map((integration) => ({
			id: integration.id,
			provider: integration.provider,
			mode: integration.mode,
			status: integration.status,
			isActive: integration.isActive,
			retiredAt: integration.retiredAt,
			secretHint: integration.secretHint,
			collectorId: integration.publicConfig.collectorId ?? null,
			simulator: integration.publicConfig.simulator === 'true',
			version: integration.version,
			keyVersion: integration.keyVersion,
			lastVerifiedAt: integration.lastVerifiedAt,
			lastError: integration.lastError
		})),
		// Where Mercado Pago notifies this organization's payments; pasted in its webhook settings.
		webhookUrl: `${apiPublicUrl}/webhooks/mercadopago/${id}`,
		theme: themes[0]?.tokens ?? {}
	};
}

/**
 * Asks Mercado Pago which merchant the credentials belong to. Only 400, 401
 * and 403 mean the credentials themselves are wrong (`rejected` words it);
 * rate limits and outages are worth retrying.
 */
async function checkAccount(
	request: FastifyRequest,
	organizationId: string,
	verify: () => Promise<{ collectorId: string }>,
	rejected: (status: number) => string
): Promise<{ collectorId: string }> {
	try {
		return { collectorId: (await verify()).collectorId };
	} catch (error) {
		if (error instanceof ProviderError && (error.status === 400 || error.status === 401 || error.status === 403)) {
			throw new ApiError(400, 'credentials_rejected', rejected(error.status));
		}
		request.log.warn(
			{ organizationId, providerStatus: error instanceof ProviderError ? error.status : null, cause: error instanceof Error ? error.name : 'unknown' },
			'Mercado Pago account check failed'
		);
		throw new ApiError(502, 'provider_unreachable', 'No pudimos conectar con Mercado Pago. Probá de nuevo en unos minutos.');
	}
}

/**
 * Locks the organization row FOR UPDATE, which checkout takes FOR SHARE before
 * reading the active account, and returns its Mercado Pago accounts.
 */
async function lockAccounts(tx: Executor, organizationId: string) {
	const [org] = await tx.select({ id: s.organizations.id }).from(s.organizations).where(eq(s.organizations.id, organizationId)).for('update');
	if (!org) throw notFound('Organización');
	return tx
		.select()
		.from(s.organizationIntegrations)
		.where(and(eq(s.organizationIntegrations.organizationId, organizationId), eq(s.organizationIntegrations.provider, 'mercadopago')));
}

/**
 * One active account per organization: the current one, unless it is
 * `keepId`, is retired and keeps its sealed credentials, so the orders created
 * with it are still confirmed and reconciled with it (S1, S2).
 */
async function retireActive(tx: Executor, organizationId: string, keepId: string, now: Date): Promise<void> {
	await tx
		.update(s.organizationIntegrations)
		.set({ isActive: false, retiredAt: now })
		.where(
			and(
				eq(s.organizationIntegrations.organizationId, organizationId),
				eq(s.organizationIntegrations.provider, 'mercadopago'),
				eq(s.organizationIntegrations.isActive, true),
				ne(s.organizationIntegrations.id, keepId)
			)
		);
}

const alreadyActive = () => new ApiError(409, 'already_active', 'Esta cuenta ya es la cuenta activa.');

/**
 * Payments any of the organization's accounts, active or retired, still has
 * to settle: orders awaiting payment, and payments being credited (a cash
 * ticket or a card under review), which may be approved after their order
 * expired. Removing the accounts now
 * would leave such a payment unconfirmable, since its webhook and its
 * reconciliation need the account's credentials.
 */
async function assertNoPaymentsInProgress(tx: Executor, organizationId: string, now: Date): Promise<void> {
	const awaiting = and(eq(s.orders.organizationId, organizationId), eq(s.orders.status, 'pending_payment'), gt(s.orders.expiresAt, now));
	const [{ pending } = { pending: 0 }] = await tx.select({ pending: count() }).from(s.orders).where(awaiting);
	if (pending === 0) {
		const [{ crediting } = { crediting: 0 }] = await tx
			.select({ crediting: count() })
			.from(s.payments)
			.where(and(eq(s.payments.organizationId, organizationId), inArray(s.payments.status, ['pending', 'in_process'])));
		if (crediting === 0) return;
		const many = crediting > 1;
		throw new ApiError(
			409,
			'payments_in_progress',
			`Hay ${crediting} ${many ? 'pagos' : 'pago'} en acreditación. Esperá a que ${many ? 'se aprueben o se rechacen' : 'se apruebe o se rechace'} para desvincular Mercado Pago.`
		);
	}
	const [last] = await tx.select({ expiresAt: s.orders.expiresAt }).from(s.orders).where(awaiting).orderBy(desc(s.orders.expiresAt)).limit(1);
	const [org] = await tx.select({ timezone: s.organizations.timezone }).from(s.organizations).where(eq(s.organizations.id, organizationId));
	const until = new Intl.DateTimeFormat('es-AR', { timeZone: org!.timezone, hour: '2-digit', minute: '2-digit', hour12: false }).format(last!.expiresAt);
	const many = pending > 1;
	throw new ApiError(
		409,
		'payments_in_progress',
		`Hay ${pending} ${many ? 'pagos' : 'pago'} en curso. Esperá a que ${many ? 'venzan' : 'venza'} (${until} h) para desvincular Mercado Pago.`
	);
}
