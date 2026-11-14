import { and, asc, count, desc, eq, gt, inArray, orgRoles, schema as s, type Database, type Executor } from '@sortea/db';
import { AdminUserError, MembershipError, addOrganizationMember, createAdminUser, setAdminUserAlias, updateOrganizationMember } from '@sortea/db/admin-users';
import {
	mapsUrlSchema,
	publicContact,
	publicSocial,
	resolveTheme,
	socialLinksSchema,
	themeOverridesSchema,
	themeToCss,
	webhookSecretIssue,
	whatsappNumberSchema
} from '@sortea/domain';
import { maskSecret, sealSecret } from '@sortea/domain/server';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requirePlatformAdmin } from '../lib/admin-context';
import { audit } from '../lib/audit';
import { saveMapsUrl, saveSocial, saveWhatsApp } from '../lib/organization-contact';
import { ApiError, notFound, parse } from '../lib/errors';
import { normalizeHostname } from '../lib/tenant';
import { confirmWithAuthenticator } from '../lib/totp-confirmation';
import { accountRole, integrationOwner, loadMercadoPagoAccounts, type MercadoPagoAccount } from '../payments/integrations';
import { ProviderError, type ProviderAccount } from '../payments/provider';

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
	/** The owner's account: an existing user with this email, or a new one with a temporary password shown once. */
	ownerEmail: z.preprocess((value) => (value === '' ? undefined : value), z.email('Email inválido').max(254).optional())
});

/**
 * A display name next to the email (S4, feedback 2026-11-10): trimmed, and blank means none.
 * Required on edit, so a body without it never clears the stored alias; optional at creation.
 */
const alias = z.preprocess(
	(value) => (typeof value === 'string' ? value.trim() || null : value),
	z
		.string({ error: (issue) => (issue.input === undefined ? 'Indicá el alias, o dejalo vacío para quitarlo' : undefined) })
		.max(60, 'El alias puede tener hasta 60 caracteres')
		.nullable()
);
/** A person given a role in an organization (draw-room T4): a new account gets a temporary password shown once. */
const addMemberBody = z.object({ email: z.email('Email inválido').max(254), role: z.enum(orgRoles) });
/** A role change, a status change or both; `invited` is not set by hand. */
const updateMemberBody = z
	.object({ role: z.enum(orgRoles).optional(), status: z.enum(['active', 'disabled']).optional() })
	.refine((value) => value.role !== undefined || value.status !== undefined, { message: 'Indicá el rol o el estado' });
const memberParams = z.object({ id: z.uuid(), userId: z.uuid() });

const createUser = z.object({ email: z.email('Email inválido').max(254), alias: alias.default(null), platformAdmin: z.boolean().default(false) });

const accessToken = z.string().trim().regex(/^(APP_USR|TEST)-[A-Za-z0-9-]{10,200}$/, 'Access token inválido');
const webhookSecret = z
	.string()
	.trim()
	.min(16, 'La firma secreta del webhook es demasiado corta: copiala completa de Mercado Pago (Configuración de webhooks, Firma secreta)')
	.max(200, 'La firma secreta del webhook es demasiado larga');

const mercadoPagoBody = z.object({
	mode: z.enum(['sandbox', 'production']),
	accessToken,
	webhookSecret,
	publicKey: z.string().trim().max(200, 'La public key es demasiado larga').optional(),
	/** `principal` for the first account or the principal's own credentials again; `backup` for the account ready to take over (S4). */
	role: z.enum(['principal', 'backup']).default('principal')
});

/** The platform admin's current authenticator code, which every change of the account that charges needs (S5, L3). */
const codeBody = z.object({ code: z.string().trim().regex(/^\d{6}$/, 'Ingresá los 6 dígitos del código de tu app de autenticación') });

/** A field left empty keeps the stored value. */
const keepWhenEmpty = <T extends z.ZodType>(schema: T) => z.preprocess((value) => (typeof value === 'string' && value.trim() === '' ? undefined : value), schema.optional());
const credentialsUpdateBody = z.object({ accessToken: keepWhenEmpty(accessToken), webhookSecret: keepWhenEmpty(webhookSecret) });

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
				await audit(tx, { organizationId: org.id, actorType: 'platform_admin', actorId: identity.userId, action: 'organization.created', targetType: 'organization', targetId: org.id });
				const owner = body.ownerEmail ? await addOwner(tx, org.id, body.ownerEmail, identity.userId, deps.now()) : null;
				return { id: org.id, owner };
			})
		);
		app.tenants.invalidate();
		const detail = await deps.db.withPlatform((db) => organizationDetail(db, created.id, deps.config.API_PUBLIC_URL));
		// The temporary password of a new owner travels in this response only; it is never stored or shown again.
		return reply.status(201).send({ ...detail, owner: created.owner });
	});

	/** Back-office accounts of every organization and of the platform staff (ADR 0020). */
	app.get('/platform/users', async (request) => {
		await requirePlatformAdmin(request);
		return deps.db.withPlatform(async (db) => {
			const [users, staff, memberships] = await Promise.all([
				db.select().from(s.adminUsers).orderBy(asc(s.adminUsers.email)),
				db.select({ userId: s.platformAdmins.userId }).from(s.platformAdmins),
				db
					.select({ userId: s.organizationMembers.userId, role: s.organizationMembers.role, organization: s.organizations.name })
					.from(s.organizationMembers)
					.innerJoin(s.organizations, eq(s.organizations.id, s.organizationMembers.organizationId))
			]);
			return {
				users: users.map((user) => ({
					id: user.id,
					email: user.email,
					alias: user.alias,
					status: user.status,
					mustChangePassword: user.mustChangePassword,
					mfa: user.totpConfirmedAt !== null,
					platformAdmin: staff.some((row) => row.userId === user.id),
					organizations: memberships.filter((row) => row.userId === user.id).map((row) => ({ name: row.organization, role: row.role })),
					lastSignInAt: user.lastSignInAt
				}))
			};
		});
	});

	/** Creates an account with a temporary password, returned once; the person must change it at the first sign-in. */
	app.post('/platform/users', async (request, reply) => {
		const identity = await requirePlatformAdmin(request);
		const body = parse(createUser, request.body);
		const created = await deps.db.withPlatform((db) =>
			db.transaction(async (tx) => {
				const user = await createAdminUser(tx, { email: body.email, alias: body.alias }, deps.now()).catch(userConflict);
				if (body.platformAdmin) await tx.insert(s.platformAdmins).values({ userId: user.id, email: user.email });
				// The alias is not secret, but the audit records only whether one was set, like contact channels.
				await audit(tx, { organizationId: null, actorType: 'platform_admin', actorId: identity.userId, action: 'admin_user.created', targetType: 'admin_user', targetId: user.id, metadata: { platformAdmin: body.platformAdmin, alias: body.alias !== null } });
				return user;
			})
		);
		return reply
			.status(201)
			.send({ user: { id: created.id, email: created.email, alias: body.alias, platformAdmin: body.platformAdmin }, temporaryPassword: created.temporaryPassword });
	});

	/** Sets or removes (empty) a user's alias (S4). Audited as whether one is set, without its value. */
	app.patch('/platform/users/:id', async (request) => {
		const identity = await requirePlatformAdmin(request);
		const { id } = parse(idParams, request.params);
		const body = parse(z.object({ alias }), request.body);
		const user = await deps.db.withPlatform((db) =>
			db.transaction(async (tx) => {
				const updated = await setAdminUserAlias(tx, id, body.alias, deps.now());
				if (!updated) throw notFound('Usuario');
				await audit(tx, { organizationId: null, actorType: 'platform_admin', actorId: identity.userId, action: 'admin_user.alias_updated', targetType: 'admin_user', targetId: id, metadata: { alias: body.alias !== null } });
				return updated;
			})
		);
		return { user };
	});

	/**
	 * Gives a person a role in the organization (draw-room T4, S3), creating the
	 * account when there is none; its temporary password travels in this
	 * response only. A member already there is refused: the role is changed below.
	 */
	app.post('/platform/organizations/:id/members', async (request, reply) => {
		const identity = await requirePlatformAdmin(request);
		const { id } = parse(idParams, request.params);
		const body = parse(addMemberBody, request.body);
		const member = await deps.db.withPlatform((db) =>
			db.transaction(async (tx) => {
				const [org] = await tx.select({ id: s.organizations.id }).from(s.organizations).where(eq(s.organizations.id, id));
				if (!org) throw notFound('Organización');
				return addMember(tx, id, body.email, body.role, identity.userId, deps.now());
			})
		);
		const detail = await deps.db.withPlatform((db) => organizationDetail(db, id, deps.config.API_PUBLIC_URL));
		return reply.status(201).send({ ...detail, member });
	});

	/** Changes a member's role or disables (or enables) the membership; the organization keeps an active owner. */
	app.patch('/platform/organizations/:id/members/:userId', async (request) => {
		const identity = await requirePlatformAdmin(request);
		const { id, userId } = parse(memberParams, request.params);
		const body = parse(updateMemberBody, request.body);
		await deps.db.withPlatform((db) =>
			db.transaction(async (tx) => {
				const changed = await updateOrganizationMember(tx, { organizationId: id, userId, ...body }).catch(membershipConflict);
				await audit(tx, {
					organizationId: id,
					actorType: 'platform_admin',
					actorId: identity.userId,
					action: 'organization.member_updated',
					targetType: 'admin_user',
					targetId: userId,
					metadata: { from: changed.from, to: changed.to }
				});
			})
		);
		return deps.db.withPlatform((db) => organizationDetail(db, id, deps.config.API_PUBLIC_URL));
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

	/**
	 * Removes a domain, for instance one added by mistake (2026-11-10). The
	 * organization keeps at least one, and the host the console is being used
	 * from is never removed, so the console cannot lock itself out. Removing the
	 * primary domain makes the oldest remaining one primary, since emails and
	 * payment redirects link to it.
	 */
	app.delete('/platform/organizations/:id/domains/:hostname', async (request) => {
		const identity = await requirePlatformAdmin(request);
		const { id, hostname: target } = parse(z.object({ id: z.uuid(), hostname }), request.params);
		const current = request.headers['x-tenant-host'];
		if (typeof current === 'string' && normalizeHostname(current) === target) {
			throw new ApiError(409, 'current_host', `No se puede quitar ${target}: es el dominio desde el que estás usando la consola. Entrá desde otro dominio para quitarlo.`);
		}
		await deps.db.withPlatform((db) =>
			db.transaction(async (tx) => {
				// Two removals at once must not leave the organization without a domain.
				const [org] = await tx.select({ id: s.organizations.id }).from(s.organizations).where(eq(s.organizations.id, id)).for('update');
				if (!org) throw notFound('Organización');
				const domains = await tx
					.select()
					.from(s.organizationDomains)
					.where(eq(s.organizationDomains.organizationId, id))
					.orderBy(asc(s.organizationDomains.createdAt), asc(s.organizationDomains.hostname));
				const domain = domains.find((candidate) => candidate.hostname === target);
				if (!domain) throw notFound('Dominio');
				if (domains.length === 1) {
					throw new ApiError(409, 'last_domain', `No se puede quitar ${target}: es el único dominio de la organización. Agregá el dominio correcto antes de quitarlo.`);
				}
				await tx.delete(s.organizationDomains).where(eq(s.organizationDomains.id, domain.id));
				const promoted = domain.isPrimary ? domains.find((candidate) => candidate.id !== domain.id)! : null;
				if (promoted) await tx.update(s.organizationDomains).set({ isPrimary: true }).where(eq(s.organizationDomains.id, promoted.id));
				await audit(tx, {
					organizationId: id,
					actorType: 'platform_admin',
					actorId: identity.userId,
					action: 'organization.domain_removed',
					targetType: 'organization',
					targetId: id,
					metadata: { hostname: target, wasPrimary: domain.isPrimary, ...(promoted ? { primary: promoted.hostname } : {}) }
				});
			})
		);
		app.tenants.invalidate();
		return deps.db.withPlatform((db) => organizationDetail(db, id, deps.config.API_PUBLIC_URL));
	});

	/**
	 * Public contact channels; the WhatsApp number is stored as the digits wa.me
	 * expects (S5). The Google Maps link (S3, 2026-10-30) is optional in the body:
	 * absent leaves it as it was, empty removes it. The audit records only which
	 * channels are set, never their values.
	 */
	app.put('/platform/organizations/:id/contact', async (request) => {
		const identity = await requirePlatformAdmin(request);
		const { id } = parse(idParams, request.params);
		const { whatsapp, mapsUrl } = parse(z.object({ whatsapp: whatsappNumberSchema, mapsUrl: mapsUrlSchema.optional() }), request.body);
		await deps.db.withPlatform((db) =>
			db.transaction(async (tx) => {
				await saveWhatsApp(tx, id, whatsapp, deps.now());
				if (mapsUrl !== undefined) await saveMapsUrl(tx, id, mapsUrl, deps.now());
				const metadata = mapsUrl === undefined ? { whatsapp: Boolean(whatsapp) } : { whatsapp: Boolean(whatsapp), mapsUrl: Boolean(mapsUrl) };
				await audit(tx, { organizationId: id, actorType: 'platform_admin', actorId: identity.userId, action: 'organization.contact_updated', targetType: 'organization', targetId: id, metadata });
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
	 * As the principal, only the organization's first account, or the
	 * principal's own merchant and mode again (a rotation), is accepted: any
	 * other change of who gets paid goes through the backup and the admin's code
	 * (ADR 0017, amendment 2026-11-11). As the backup, the account is stored
	 * verified without charging; a different backup moves the previous one to
	 * the previous accounts, so there is at most one. Both hold the organization
	 * row like every switch.
	 */
	app.put('/platform/organizations/:id/integrations/mercadopago', async (request) => {
		const identity = await requirePlatformAdmin(request);
		const { id } = parse(idParams, request.params);
		const body = parse(mercadoPagoBody, request.body);
		assertWebhookSecret(body.webhookSecret);
		if (body.mode === 'production' && !body.accessToken.startsWith('APP_USR-')) throw productionToken();
		const [known] = await deps.db.withPlatform((db) => db.select({ id: s.organizations.id }).from(s.organizations).where(eq(s.organizations.id, id)));
		if (!known) throw notFound('Organización');
		const verified = await checkAccount(
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
				const collectorId = verified.collectorId;
				const existing = rows.find((row) => row.mode === body.mode && row.publicConfig.collectorId === collectorId);
				const asBackup = body.role === 'backup';
				if (!asBackup && active && existing?.id !== active.id) throw switchRequiresBackup();
				if (asBackup && !active) throw new ApiError(409, 'principal_required', 'Primero conectá la cuenta principal; la de respaldo se suma después.');
				if (asBackup && existing?.isActive) {
					throw new ApiError(409, 'already_principal', 'Esa cuenta ya es la principal. Para renovar sus credenciales, usá «Actualizar credenciales» en la cuenta principal.');
				}
				const publicConfig = withAccountKind({ ...(body.publicKey ? { publicKey: body.publicKey } : {}), collectorId }, verified);
				const integrationId = existing?.id ?? (
					await tx
						.insert(s.organizationIntegrations)
						.values({ organizationId: id, provider: 'mercadopago', mode: body.mode, sealedSecrets: 'pending', keyVersion: deps.keyRing.current, secretHint: '', isActive: false })
						.returning({ id: s.organizationIntegrations.id })
				)[0]!.id;
				// One backup per organization: another one moves the current backup to the previous accounts.
				const replaced = asBackup ? rows.find((row) => accountRole(row) === 'backup' && row.id !== integrationId) : undefined;
				if (replaced) await tx.update(s.organizationIntegrations).set({ retiredAt: deps.now() }).where(eq(s.organizationIntegrations.id, replaced.id));
				const sealed = sealSecret(deps.keyRing, JSON.stringify({ accessToken: body.accessToken, webhookSecret: body.webhookSecret }), integrationOwner(id, integrationId));
				await tx
					.update(s.organizationIntegrations)
					.set({
						sealedSecrets: sealed,
						keyVersion: deps.keyRing.current,
						secretHint: maskSecret(body.accessToken),
						publicConfig,
						status: 'verified',
						isActive: !asBackup,
						retiredAt: null,
						lastError: null,
						lastVerifiedAt: deps.now(),
						version: (existing?.version ?? 0) + 1,
						updatedBy: identity.userId,
						updatedAt: deps.now()
					})
					.where(eq(s.organizationIntegrations.id, integrationId));
				await audit(tx, {
					organizationId: id,
					actorType: 'platform_admin',
					actorId: identity.userId,
					action: asBackup ? 'integration.mercadopago_backup_connected' : 'integration.mercadopago_updated',
					targetType: 'integration',
					targetId: integrationId,
					metadata: {
						mode: body.mode,
						version: (existing?.version ?? 0) + 1,
						collectorId,
						testUser: verified.testUser,
						...(replaced ? { replacedBackupId: replaced.id, replacedCollectorId: replaced.publicConfig.collectorId ?? null } : {})
					}
				});
			})
		);
		return deps.db.withPlatform((db) => organizationDetail(db, id, deps.config.API_PUBLIC_URL));
	});

	/**
	 * Makes the backup ("Usar como principal") or a previous account ("Volver a
	 * usar esta cuenta", S6) the principal, with its stored credentials. It
	 * changes who gets paid, so it needs the platform admin's current
	 * authenticator code first (S5, L3); a wrong, replayed or missing code
	 * changes nothing and never reaches Mercado Pago. Mercado Pago then checks
	 * the stored credentials, which must still belong to the same merchant.
	 * Like every switch it holds the organization row, so each checkout ends on
	 * one account or the other and keeps it. The backup swaps roles with the
	 * principal, which becomes the backup (L2); a previous account retires the
	 * principal and leaves the backup as it is. The principal itself is refused
	 * with 409 (already_active).
	 */
	app.post('/platform/organizations/:id/integrations/mercadopago/:integrationId/activate', async (request) => {
		const identity = await requirePlatformAdmin(request);
		const { id, integrationId } = parse(integrationParams, request.params);
		const { code } = parse(codeBody, request.body);
		const accounts = await deps.db.withTenant(id, (tx) => loadMercadoPagoAccounts(tx, id, deps.keyRing));
		const account = accounts.find((candidate) => candidate.id === integrationId);
		if (!account) throw notFound('Cuenta');
		if (account.isActive) throw alreadyActive();
		await confirmWithAuthenticator(deps, { userId: identity.userId, code, purpose: 'integration.mercadopago_activate' });
		const verified = await checkAccount(
			request,
			id,
			() => deps.payments.verifyAccount(account.credentials),
			(status) =>
				`Mercado Pago rechazó las credenciales guardadas de esta cuenta (HTTP ${status}). Cargá credenciales nuevas en «Actualizar credenciales», o conectala de nuevo como cuenta de respaldo.`
		);
		const collectorId = verified.collectorId;
		if (collectorId !== account.collectorId) {
			throw new ApiError(
				409,
				'collector_mismatch',
				`Las credenciales guardadas responden por otra cuenta de Mercado Pago (${collectorId}), no por la cuenta ${account.collectorId ?? 'sin identificar'}. Para usarla, conectala de nuevo como cuenta de respaldo.`
			);
		}
		await deps.db.withPlatform((db) =>
			db.transaction(async (tx) => {
				const rows = await lockAccounts(tx, id);
				// Read again under the lock: a switch or a disconnect may have run since.
				const row = rows.find((candidate) => candidate.id === integrationId);
				if (!row) throw notFound('Cuenta');
				if (row.isActive) throw alreadyActive();
				const promoting = accountRole(row) === 'backup';
				const active = rows.find((candidate) => candidate.isActive);
				// First, so the partial unique index never sees two active accounts.
				if (active) {
					await tx
						.update(s.organizationIntegrations)
						.set({ isActive: false, retiredAt: promoting ? null : deps.now() })
						.where(eq(s.organizationIntegrations.id, active.id));
				}
				await tx
					.update(s.organizationIntegrations)
					.set({
						status: 'verified',
						// What Mercado Pago says about the account now decides the demo waiver (ADR 0013).
						publicConfig: withAccountKind(row.publicConfig, verified),
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
					action: promoting ? 'integration.mercadopago_promoted' : 'integration.mercadopago_reactivated',
					targetType: 'integration',
					targetId: integrationId,
					// Who switched, from which account to which, and how it was confirmed; never the code.
					metadata: {
						mode: row.mode,
						collectorId,
						testUser: verified.testUser,
						confirmedWith: 'totp',
						...(active
							? { [promoting ? 'previousIntegrationId' : 'retiredIntegrationId']: active.id, previousCollectorId: active.publicConfig.collectorId ?? null }
							: {})
					}
				});
			})
		);
		return deps.db.withPlatform((db) => organizationDetail(db, id, deps.config.API_PUBLIC_URL));
	});

	/**
	 * Replaces the access token, the webhook secret or both of one account,
	 * active or previous, without switching or retiring anything (2026-11-10).
	 * A new token is checked with Mercado Pago and must answer for the account's
	 * merchant: another merchant is a switch, made through the backup. Mercado Pago
	 * cannot check a webhook secret; the signature of the next notification does
	 * (`lastWebhook` in the organization detail).
	 */
	app.patch('/platform/organizations/:id/integrations/mercadopago/:integrationId', async (request) => {
		const identity = await requirePlatformAdmin(request);
		const { id, integrationId } = parse(integrationParams, request.params);
		const body = parse(credentialsUpdateBody, request.body);
		if (!body.accessToken && !body.webhookSecret) {
			throw new ApiError(400, 'nothing_to_update', 'Cargá un access token nuevo, una firma secreta del webhook nueva o ambos.');
		}
		if (body.webhookSecret) assertWebhookSecret(body.webhookSecret);
		const accounts = await deps.db.withTenant(id, (tx) => loadMercadoPagoAccounts(tx, id, deps.keyRing));
		const account = accounts.find((candidate) => candidate.id === integrationId);
		if (!account) throw notFound('Cuenta');
		const newToken = body.accessToken;
		if (newToken && account.mode === 'production' && !newToken.startsWith('APP_USR-')) throw productionToken();
		const verified = newToken
			? await checkAccount(
					request,
					id,
					() => deps.payments.verifyAccount({ accessToken: newToken, webhookSecret: body.webhookSecret ?? account.credentials.webhookSecret }),
					(status) => `Mercado Pago rechazó el access token nuevo (HTTP ${status}). Revisá que sea el de esta cuenta y de este entorno.`
				)
			: null;
		const fields = [...(newToken ? ['accessToken'] : []), ...(body.webhookSecret ? ['webhookSecret'] : [])];
		await deps.db.withPlatform((db) =>
			db.transaction(async (tx) => {
				const rows = await lockAccounts(tx, id);
				const row = rows.find((candidate) => candidate.id === integrationId);
				if (!row) throw notFound('Cuenta');
				const collectorId = row.publicConfig.collectorId ?? null;
				if (verified && verified.collectorId !== collectorId) {
					throw new ApiError(
						409,
						'collector_mismatch',
						`El access token nuevo es de otra cuenta de Mercado Pago (${verified.collectorId}), no de la cuenta ${collectorId ?? 'sin identificar'}. Para cobrar con otra cuenta, conectala como cuenta de respaldo y usá «Usar como principal».`
					);
				}
				// Read again under the lock: the field left as it was keeps its latest stored value.
				const stored = (await loadMercadoPagoAccounts(tx, id, deps.keyRing)).find((candidate) => candidate.id === integrationId)!.credentials;
				const credentials = { accessToken: newToken ?? stored.accessToken, webhookSecret: body.webhookSecret ?? stored.webhookSecret };
				const version = row.version + 1;
				await tx
					.update(s.organizationIntegrations)
					.set({
						sealedSecrets: sealSecret(deps.keyRing, JSON.stringify(credentials), integrationOwner(id, integrationId)),
						keyVersion: deps.keyRing.current,
						// Like a verification, a checked token refreshes the account's health and kind (ADR 0013).
						...(verified
							? {
									secretHint: maskSecret(credentials.accessToken),
									publicConfig: withAccountKind(row.publicConfig, verified),
									status: 'verified' as const,
									lastError: null,
									lastVerifiedAt: deps.now()
								}
							: {}),
						version,
						updatedBy: identity.userId,
						updatedAt: deps.now()
					})
					.where(eq(s.organizationIntegrations.id, integrationId));
				await audit(tx, {
					organizationId: id,
					actorType: 'platform_admin',
					actorId: identity.userId,
					action: 'integration.mercadopago.credentials_updated',
					targetType: 'integration',
					targetId: integrationId,
					metadata: { fields, mode: row.mode, collectorId, active: row.isActive, version, ...(verified ? { testUser: verified.testUser } : {}) }
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
	 *
	 * It needs the platform admin's code like a switch (S5): without it, a
	 * disconnect followed by a first connection would change who gets paid. A
	 * wrong, replayed or missing code deletes nothing; the payments in progress
	 * are checked after the code, under the organization row lock.
	 */
	app.delete('/platform/organizations/:id/integrations/mercadopago', async (request) => {
		const identity = await requirePlatformAdmin(request);
		const { id } = parse(idParams, request.params);
		const { code } = parse(codeBody, request.body ?? {});
		// Nothing to disconnect is answered before the code is spent, like activating the principal.
		const [known] = await deps.db.withPlatform((db) =>
			db
				.select({ id: s.organizationIntegrations.id })
				.from(s.organizationIntegrations)
				.innerJoin(s.organizations, eq(s.organizations.id, s.organizationIntegrations.organizationId))
				.where(and(eq(s.organizationIntegrations.organizationId, id), eq(s.organizationIntegrations.provider, 'mercadopago')))
				.limit(1)
		);
		if (!known) throw notFound('Integración');
		await confirmWithAuthenticator(deps, { userId: identity.userId, code, purpose: 'integration.mercadopago_disconnect' });
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
					metadata: { modes: rows.map((row) => row.mode), collectorId: active.publicConfig.collectorId ?? null, confirmedWith: 'totp' }
				});
			})
		);
		return deps.db.withPlatform((db) => organizationDetail(db, id, deps.config.API_PUBLIC_URL));
	});

	/** "Verificar conexión" of the principal; kept for callers that name no account. */
	app.post('/platform/organizations/:id/integrations/mercadopago/verify', async (request) => {
		const identity = await requirePlatformAdmin(request);
		const { id } = parse(idParams, request.params);
		return verifyStored(request, identity.userId, id, (accounts) => accounts.find((account) => account.isActive));
	});

	/**
	 * "Verificar conexión" of one account, the principal, the backup or a previous
	 * one, whichever charges (S6): its stored credentials are checked with
	 * Mercado Pago and the result is recorded on that account only. It never
	 * changes which account charges.
	 */
	app.post('/platform/organizations/:id/integrations/mercadopago/:integrationId/verify', async (request) => {
		const identity = await requirePlatformAdmin(request);
		const { id, integrationId } = parse(integrationParams, request.params);
		return verifyStored(request, identity.userId, id, (accounts) => accounts.find((account) => account.id === integrationId));
	});

	/** Calls the provider with the stored credentials of the picked account and records the merchant id used to validate payments. */
	async function verifyStored(request: FastifyRequest, actorId: string, id: string, pick: (accounts: MercadoPagoAccount[]) => MercadoPagoAccount | undefined) {
		const integration = pick(await deps.db.withTenant(id, (tx) => loadMercadoPagoAccounts(tx, id, deps.keyRing)));
		if (!integration) throw notFound('Integración');
		let result: { status: 'verified' | 'error'; account?: ProviderAccount; error?: string };
		try {
			result = { status: 'verified', account: await deps.payments.verifyAccount(integration.credentials) };
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
					publicConfig: result.account ? withAccountKind({ ...row!.publicConfig, collectorId: result.account.collectorId }, result.account) : row!.publicConfig
				})
				.where(eq(s.organizationIntegrations.id, integration.id));
			await audit(db, {
				organizationId: id,
				actorType: 'platform_admin',
				actorId,
				action: 'integration.mercadopago_verified',
				targetType: 'integration',
				targetId: integration.id,
				metadata: { status: result.status, role: accountRole(row!) }
			});
		});
		return deps.db.withPlatform((db) => organizationDetail(db, id, deps.config.API_PUBLIC_URL));
	}
}

function userConflict(error: unknown): never {
	if (error instanceof AdminUserError && error.code === 'user_exists') throw new ApiError(409, 'user_exists', 'Ya existe un usuario con ese email');
	throw error;
}

function membershipConflict(error: unknown): never {
	if (error instanceof MembershipError) {
		if (error.code === 'member_exists') throw new ApiError(409, 'member_exists', 'Esa persona ya es miembro de la organización: cambiale el rol desde la lista');
		if (error.code === 'last_owner') throw new ApiError(409, 'last_owner', 'La organización tiene que conservar al menos un dueño activo');
		throw notFound('Miembro');
	}
	throw error;
}

/**
 * Gives the user with this email a role in the organization, creating the
 * account when it does not exist yet, both audited. Returns the temporary
 * password of a new account, to be shown once to the platform admin.
 */
async function addMember(tx: Executor, organizationId: string, email: string, role: (typeof orgRoles)[number], actorId: string, now: Date) {
	const member = await addOrganizationMember(tx, { organizationId, email, role }, now).catch(membershipConflict);
	if (member.created) {
		await audit(tx, { organizationId, actorType: 'platform_admin', actorId, action: 'admin_user.created', targetType: 'admin_user', targetId: member.userId, metadata: { platformAdmin: false } });
	}
	await audit(tx, { organizationId, actorType: 'platform_admin', actorId, action: 'organization.member_added', targetType: 'admin_user', targetId: member.userId, metadata: { role } });
	return { userId: member.userId, email: member.email, role, created: member.created, temporaryPassword: member.temporaryPassword };
}

/** Makes the user with this email the new organization's owner (see `addMember`). */
async function addOwner(tx: Executor, organizationId: string, email: string, actorId: string, now: Date) {
	const { email: ownerEmail, created, temporaryPassword } = await addMember(tx, organizationId, email, 'org_owner', actorId, now);
	return { email: ownerEmail, created, temporaryPassword };
}

async function organizationDetail(db: Database, id: string, apiPublicUrl: string) {
	const [org] = await db.select().from(s.organizations).where(eq(s.organizations.id, id));
	if (!org) throw notFound('Organización');
	const [domains, members, integrations, themes, webhooks] = await Promise.all([
		db
			.select()
			.from(s.organizationDomains)
			.where(eq(s.organizationDomains.organizationId, id))
			.orderBy(asc(s.organizationDomains.createdAt), asc(s.organizationDomains.hostname)),
		db
			.select({ userId: s.organizationMembers.userId, email: s.organizationMembers.email, alias: s.adminUsers.alias, role: s.organizationMembers.role, status: s.organizationMembers.status })
			.from(s.organizationMembers)
			.leftJoin(s.adminUsers, eq(s.adminUsers.id, s.organizationMembers.userId))
			.where(eq(s.organizationMembers.organizationId, id))
			.orderBy(asc(s.organizationMembers.createdAt), asc(s.organizationMembers.email)),
		db.select().from(s.organizationIntegrations).where(eq(s.organizationIntegrations.organizationId, id)),
		db.select().from(s.organizationThemes).where(and(eq(s.organizationThemes.organizationId, id), eq(s.organizationThemes.isActive, true))),
		// What the webhook route recorded last, without the order id or the payload.
		db
			.select({ receivedAt: s.paymentEvents.receivedAt, topic: s.paymentEvents.topic, signatureValid: s.paymentEvents.signatureValid, outcome: s.paymentEvents.outcome })
			.from(s.paymentEvents)
			.where(and(eq(s.paymentEvents.organizationId, id), eq(s.paymentEvents.provider, 'mercadopago')))
			.orderBy(desc(s.paymentEvents.receivedAt))
			.limit(1)
	]);
	// The last notification each account's secret validated (S6), so a backup is checked before it charges.
	// One query per account, which reads the newest entry of payment_events_integration_idx (integration_id,
	// created_at); an organization has a handful of accounts.
	const signedBy = new Map(
		await Promise.all(
			integrations.map(async (integration) => {
				const [event] = await db
					.select({ receivedAt: s.paymentEvents.receivedAt, topic: s.paymentEvents.topic, signatureValid: s.paymentEvents.signatureValid, outcome: s.paymentEvents.outcome })
					.from(s.paymentEvents)
					.where(and(eq(s.paymentEvents.integrationId, integration.id), eq(s.paymentEvents.organizationId, id)))
					.orderBy(desc(s.paymentEvents.receivedAt))
					.limit(1);
				return [integration.id, event] as const;
			})
		)
	);
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
		members: members.map((member) => ({ userId: member.userId, email: member.email, alias: member.alias ?? null, role: member.role, status: member.status })),
		// Write-only secrets: only the hint, mode and health ever leave the API.
		integrations: integrations.map((integration) => ({
			id: integration.id,
			provider: integration.provider,
			mode: integration.mode,
			status: integration.status,
			/** principal, backup or previous (ADR 0017, amendment 2026-11-11). */
			role: accountRole(integration),
			isActive: integration.isActive,
			retiredAt: integration.retiredAt,
			secretHint: integration.secretHint,
			collectorId: integration.publicConfig.collectorId ?? null,
			simulator: integration.publicConfig.simulator === 'true',
			/** Mercado Pago reported a test user at the last check: fictitious money (ADR 0013). */
			testUser: integration.publicConfig.testUser === 'true',
			version: integration.version,
			keyVersion: integration.keyVersion,
			lastVerifiedAt: integration.lastVerifiedAt,
			lastError: integration.lastError,
			/** The last notification this account's secret validated, without the order id or the payload. */
			lastWebhook: signedBy.get(integration.id) ?? null
		})),
		// Where Mercado Pago notifies this organization's payments; pasted in its webhook settings.
		webhookUrl: `${apiPublicUrl}/webhooks/mercadopago/${id}`,
		/** The last notification received: an invalid signature means the stored webhook secret is not Mercado Pago's. */
		lastWebhook: webhooks[0] ?? null,
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
	verify: () => Promise<ProviderAccount>,
	rejected: (status: number) => string
): Promise<ProviderAccount> {
	try {
		return await verify();
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
 * The account's public config with what the provider said at this check: a
 * Mercado Pago test user (`testUser`) or the local simulator (`simulator`).
 * Only these accounts can run the compliance demo waiver (ADR 0013).
 */
function withAccountKind(publicConfig: Record<string, string>, account: ProviderAccount): Record<string, string> {
	const kept = Object.fromEntries(Object.entries(publicConfig).filter(([key]) => key !== 'testUser' && key !== 'simulator'));
	return { ...kept, ...(account.testUser ? { testUser: 'true' } : {}), ...(account.simulator ? { simulator: 'true' } : {}) };
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

const alreadyActive = () => new ApiError(409, 'already_active', 'Esta cuenta ya es la cuenta activa.');
const switchRequiresBackup = () =>
	new ApiError(
		409,
		'switch_requires_backup',
		'Esta organización ya cobra con otra cuenta. Conectá la nueva como cuenta de respaldo y después usá «Usar como principal», que pide el código de tu app de autenticación.'
	);
const productionToken = () => new ApiError(400, 'invalid_token', 'Producción requiere un access token APP_USR');

/** Refuses a credential pasted where the webhook's "Firma secreta" goes: every notification would fail its signature. */
function assertWebhookSecret(secret: string): void {
	const issue = webhookSecretIssue(secret);
	if (issue) throw new ApiError(400, 'invalid_webhook_secret', issue);
}

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
