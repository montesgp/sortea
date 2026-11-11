import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createDatabase, eq, schema as s, type DatabaseHandle } from '@sortea/db';
import { importGeoNames } from '@sortea/db/geonames';
import { base32Encode, generateTotpSecret, parseKeyRing, sealSecret, signWebhook, totpCode, totpStep } from '@sortea/domain/server';
import { inject } from 'vitest';
import { buildApp } from '../src/app';
import type { AppDeps } from '../src/context';
import { tokenHash, type Assurance } from '../src/lib/admin-auth';
import { totpOwner } from '../src/lib/totp-confirmation';
import { integrationOwner } from '../src/payments/integrations';
import type { PaymentProvider } from '../src/payments/provider';
import { createPaymentSimulator, simulatorCollectorId, type PaymentSimulator } from '../src/payments/simulator';

export const INTERNAL_TOKEN = 'test-internal-token-0123456789';
/** scrypt with N=1024: fixtures sign in through sessions, so their hash only has to be well formed. */
const FIXTURE_PASSWORD_HASH = `scrypt$N=1024,r=8,p=1$${Buffer.alloc(16, 1).toString('base64url')}$${Buffer.alloc(64, 2).toString('base64url')}`;

export interface TestContext {
	app: Awaited<ReturnType<typeof buildApp>>;
	db: DatabaseHandle;
	deps: AppDeps;
	simulator: ReturnType<typeof createPaymentSimulator>;
	clock: { now: Date };
	/** Objects in the fake public media bucket. */
	media: { objects: Map<string, { bytes: Buffer; contentType: string }> };
	/** Paths removed from the fake product files bucket. */
	files: { removed: string[] };
	/**
	 * A session token for this user, as the sign-in returns it; the account is
	 * created when missing. Defaults to an MFA session.
	 */
	signAdmin(userId: string, email: string, assurance?: Assurance): Promise<string>;
	close(): Promise<void>;
}

export async function createTestContext(
	options: {
		live?: { lifetimeMs?: number; heartbeatMs?: number };
		complianceDemo?: boolean;
		/** REQUIRE_ADMIN_MFA, as in production. */
		requireMfa?: boolean;
		logStream?: { write(line: string): void };
		/** Replaces the provider port, e.g. the simulator with a real adapter's account check. */
		payments?: (simulator: PaymentSimulator) => PaymentProvider;
	} = {}
): Promise<TestContext> {
	const db = createDatabase(inject('databaseUrl'), { max: 8 });
	const clock = { now: new Date('2026-10-25T15:00:00Z') };
	const keyRing = parseKeyRing(`v1:${randomBytes(32).toString('base64')}`);
	const simulator = createPaymentSimulator({ webOrigin: 'http://localhost:5173', now: () => clock.now });
	const media = { objects: new Map<string, { bytes: Buffer; contentType: string }>() };
	const files = { removed: [] as string[] };

	const deps: AppDeps = {
		config: {
			NODE_ENV: 'test',
			API_PUBLIC_URL: 'http://api.test',
			WEB_FALLBACK_ORIGIN: 'http://localhost:5173',
			LOOKUP_PEPPER: 'lookup-pepper-for-tests-only',
			PSEUDONYM_PEPPER: 'pseudonym-pepper-for-tests-only',
			INTERNAL_API_TOKEN: INTERNAL_TOKEN,
			REQUIRE_ADMIN_MFA: options.requireMfa ?? false,
			COMPLIANCE_DEMO: options.complianceDemo ?? false
		},
		db,
		keyRing,
		payments: options.payments ? options.payments(simulator) : simulator,
		simulator,
		storage: {
			signedUrl: async (path, seconds) => `https://storage.test/${path}?expires=${seconds}`,
			async remove(paths) {
				files.removed.push(...paths);
			}
		},
		media: {
			async upload(path, bytes, contentType) {
				media.objects.set(path, { bytes: Buffer.from(bytes), contentType });
			},
			async remove(path) {
				media.objects.delete(path);
			},
			publicUrl: (path) => `https://media.test/${path}`,
			// One URL per hour of the clock, like the real adapter's fixed windows.
			async signedUrl(path, now) {
				const hour = Math.floor(now.getTime() / 3_600_000);
				return { url: `https://media.test/signed/${path}?window=${hour}`, maxAgeSeconds: 3600 - Math.floor((now.getTime() % 3_600_000) / 1000) };
			}
		},
		now: () => clock.now
	};
	const app = await buildApp(deps, { logger: options.logStream ? { stream: options.logStream } : process.env.TEST_LOG === '1', live: options.live });

	return {
		app,
		db,
		deps,
		simulator,
		clock,
		media,
		files,
		async signAdmin(userId, email, assurance = 'mfa') {
			await ensureFixtureUser(db, userId, email);
			// Suites move the clock by days, so fixture sessions never expire; admin-sign-in.test.ts covers expiry.
			const token = randomBytes(32).toString('base64url');
			const never = new Date('2999-01-01T00:00:00Z');
			await db.withPlatform((platform) =>
				platform.insert(s.adminSessions).values({ tokenHash: tokenHash(token), userId, assurance, lastSeenAt: never, expiresAt: never, idleExpiresAt: never })
			);
			return token;
		},
		async close() {
			await app.close();
			await db.close();
		}
	};
}

/** The account of a fixture user, with the given email unless another account has it. */
export async function ensureFixtureUser(db: DatabaseHandle, userId: string, email: string): Promise<void> {
	await db.withPlatform(async (platform) => {
		const [known] = await platform.select({ id: s.adminUsers.id }).from(s.adminUsers).where(eq(s.adminUsers.id, userId));
		if (known) return;
		const inserted = await platform.insert(s.adminUsers).values({ id: userId, email, passwordHash: FIXTURE_PASSWORD_HASH }).onConflictDoNothing().returning({ id: s.adminUsers.id });
		if (inserted.length === 0) await platform.insert(s.adminUsers).values({ id: userId, email: `${userId}@users.test`, passwordHash: FIXTURE_PASSWORD_HASH });
	});
}

export interface TenantFixture {
	id: string;
	host: string;
	webhookSecret: string;
	ownerId: string;
	operatorId: string;
	manualVariantId: string;
	stickerVariantId: string;
	campaignId: string;
	campaignSlug: string;
}

/**
 * A complete tenant: domain, payment account, catalog and a published campaign awaiting approvals.
 * With `mercadoPago: false` it has no payment account, so the first one connected through the
 * platform console is its principal.
 */
export async function createTenant(ctx: TestContext, label: string, options: { mercadoPago?: boolean } = {}): Promise<TenantFixture> {
	const id = randomUUID();
	const host = `${label}-${id.slice(0, 8)}.test`;
	const webhookSecret = `whsec-${randomBytes(16).toString('hex')}`;
	const accessToken = `TEST-${randomBytes(16).toString('hex')}`;
	const ownerId = randomUUID();
	const operatorId = randomUUID();
	const ids = { manual: randomUUID(), sticker: randomUUID(), campaign: randomUUID(), manualProduct: randomUUID(), stickerProduct: randomUUID() };

	await ctx.db.withPlatform(async (db) => {
		await db.insert(s.organizations).values({
			id,
			slug: `${label}-${id.slice(0, 8)}`,
			name: label,
			orderPrefix: 'TT',
			settings: {
				contact: {},
				social: {},
				delivery: { pickupEnabled: true, shippingEnabled: true, shippingFeeMinor: 500_000 },
				legal: { termsVersion: 't1', privacyVersion: 'p1' }
			}
		});
		await db.insert(s.organizationDomains).values({ organizationId: id, hostname: host, isPrimary: true });
		await db.insert(s.organizationMembers).values([
			{ organizationId: id, userId: ownerId, email: `owner@${host}`, role: 'org_owner' },
			{ organizationId: id, userId: operatorId, email: `operator@${host}`, role: 'campaign_operator' }
		]);
		const integrationId = randomUUID();
		if (options.mercadoPago !== false) {
			await db.insert(s.organizationIntegrations).values({
				id: integrationId,
				organizationId: id,
				provider: 'mercadopago',
				mode: 'sandbox',
				publicConfig: { collectorId: simulatorCollectorId(accessToken), simulator: 'true' },
				sealedSecrets: sealSecret(ctx.deps.keyRing, JSON.stringify({ accessToken, webhookSecret }), integrationOwner(id, integrationId)),
				keyVersion: 1,
				secretHint: 'TEST••••'
			});
		}
		await db.insert(s.products).values([
			{ id: ids.manualProduct, organizationId: id, slug: 'manual', name: 'Manual', description: 'PDF', kind: 'digital', status: 'active' },
			{ id: ids.stickerProduct, organizationId: id, slug: 'sticker', name: 'Calcomanía', description: 'Vinilo', kind: 'physical', status: 'active' }
		]);
		await db.insert(s.productVariants).values([
			{ id: ids.manual, organizationId: id, productId: ids.manualProduct, sku: 'M', name: 'Manual', priceMinor: 1_200_000 },
			{ id: ids.sticker, organizationId: id, productId: ids.stickerProduct, sku: 'S', name: 'Calcomanía', priceMinor: 350_000, stock: 2 }
		]);
		await db.insert(s.productAssets).values({
			organizationId: id,
			productId: ids.manualProduct,
			storagePath: `${id}/manual.pdf`,
			filename: 'manual.pdf',
			contentType: 'application/pdf',
			sizeBytes: 100
		});
		await db.insert(s.campaigns).values({
			id: ids.campaign,
			organizationId: id,
			slug: 'moto',
			title: 'Moto 0 km',
			summary: 'Campaña de prueba',
			status: 'published',
			timezone: 'America/Argentina/Buenos_Aires',
			opensAt: new Date('2026-10-20T00:00:00Z'),
			closesAt: new Date('2026-11-28T23:00:00Z')
		});
		await db.insert(s.campaignApprovals).values([
			{ organizationId: id, campaignId: ids.campaign, kind: 'legal' },
			{ organizationId: id, campaignId: ids.campaign, kind: 'psp' }
		]);
		await db.insert(s.campaignRuleVersions).values({
			organizationId: id,
			campaignId: ids.campaign,
			version: 1,
			bodyMarkdown: 'Bases de prueba con texto suficiente.',
			eligibility: { minAge: 18, residency: 'AR', excluded: [] },
			entryRule: { mode: 'per_unit', entriesPerUnit: { [ids.manual]: 1 }, maxEntriesPerIdentity: null }
		});
		// AC-06: one vehicle, ten cash prizes and five physical prizes.
		await db.insert(s.prizes).values([
			{ organizationId: id, campaignId: ids.campaign, position: 1, kind: 'vehicle', title: 'Moto', declaredValueMinor: 800_000_000, quantity: 1, alternatesCount: 2 },
			{ organizationId: id, campaignId: ids.campaign, position: 2, kind: 'cash', title: '$100.000', declaredValueMinor: 10_000_000, quantity: 10 },
			{ organizationId: id, campaignId: ids.campaign, position: 3, kind: 'product', title: 'Kit', declaredValueMinor: 5_000_000, quantity: 5 }
		]);
	});
	ctx.app.tenants.invalidate();

	return {
		id,
		host,
		webhookSecret,
		ownerId,
		operatorId,
		manualVariantId: ids.manual,
		stickerVariantId: ids.sticker,
		campaignId: ids.campaign,
		campaignSlug: 'moto'
	};
}

/** Loads the GeoNames fixture of the db package (4 countries: AR, BR, CL, UY). Idempotent. */
export async function loadGeoReference(ctx: TestContext) {
	return importGeoNames(ctx.db, fileURLToPath(new URL('../../../packages/db/test/fixtures/geonames', import.meta.url)));
}

export interface Authenticator {
	/** The authenticator app's secret, to compute codes of other steps. */
	readonly secret: Buffer;
	/** Moves the test clock to the next 30-second step, as a person waits for a new code, and returns that code. */
	code(): string;
}

/** A confirmed authenticator app for a fixture user (docs/spec/SECURITY.md, "Segundo factor"). */
export async function enrolAuthenticator(ctx: TestContext, userId: string): Promise<Authenticator> {
	const secret = generateTotpSecret();
	await ctx.db.withPlatform((db) =>
		db
			.update(s.adminUsers)
			.set({ totpSecretSealed: sealSecret(ctx.deps.keyRing, base32Encode(secret), totpOwner(userId)), totpConfirmedAt: ctx.clock.now, totpLastStep: null })
			.where(eq(s.adminUsers.id, userId))
	);
	return {
		secret,
		code() {
			ctx.clock.now = new Date(ctx.clock.now.getTime() + 30_000);
			return totpCode(secret, totpStep(ctx.clock.now));
		}
	};
}

/**
 * Switches the tenant to another Mercado Pago account the only way that changes
 * who gets paid (ADR 0017, amendment 2026-11-11): connected as the backup, then
 * made the principal with the platform admin's code. The former principal
 * becomes the backup. Returns the response of the step that answered last.
 */
export async function switchMercadoPago(
	ctx: TestContext,
	tenant: Pick<TenantFixture, 'id'>,
	auth: Record<string, string>,
	authenticator: Authenticator,
	account: { accessToken: string; webhookSecret: string; mode?: 'sandbox' | 'production' }
) {
	const url = `/platform/organizations/${tenant.id}/integrations/mercadopago`;
	const connected = await ctx.app.inject({
		method: 'PUT',
		url,
		headers: auth,
		payload: { mode: account.mode ?? 'sandbox', accessToken: account.accessToken, webhookSecret: account.webhookSecret, role: 'backup' }
	});
	if (connected.statusCode !== 200) return connected;
	const backup = (connected.json().integrations as { id: string; role: string }[]).find((integration) => integration.role === 'backup')!;
	return ctx.app.inject({ method: 'POST', url: `${url}/${backup.id}/activate`, headers: auth, payload: { code: authenticator.code() } });
}

export function headers(tenant: Pick<TenantFixture, 'host'>, extra: Record<string, string> = {}): Record<string, string> {
	return { 'x-internal-token': INTERNAL_TOKEN, 'x-tenant-host': tenant.host, 'x-client-ip': `10.0.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`, ...extra };
}

export async function adminHeaders(ctx: TestContext, tenant: TenantFixture, userId = tenant.ownerId) {
	return headers(tenant, { authorization: `Bearer ${await ctx.signAdmin(userId, `user-${userId.slice(0, 4)}@test`)}` });
}

export function checkoutBody(tenant: TenantFixture, overrides: Record<string, unknown> = {}) {
	return {
		lines: [{ variantId: tenant.manualVariantId, quantity: 2 }],
		buyer: { documentType: 'DNI', documentNumber: '30.123.456', firstName: 'Juana', lastName: 'Pérez', email: 'juana@example.com', phone: '+54 9 11 2345-6789', province: 'Córdoba', city: 'Río Cuarto' },
		delivery: { method: 'digital' },
		// The fixture cart gives chances once the campaign opens, so the buyer declares being an adult (S11).
		consents: { terms: true, privacy: true, marketingEmail: false, adultDeclaration: true },
		campaignSlug: tenant.campaignSlug,
		...overrides
	};
}

/** Opens the fixture campaign the legitimate way: approvals with evidence, then the transition. */
export async function openCampaign(ctx: TestContext, tenant: TenantFixture) {
	const auth = await adminHeaders(ctx, tenant);
	for (const kind of ['legal', 'psp']) {
		const response = await ctx.app.inject({
			method: 'PUT',
			url: `/admin/campaigns/${tenant.campaignId}/approvals/${kind}`,
			headers: auth,
			payload: { status: 'approved', reference: `EXP-${kind}-1`, authority: 'Autoridad de prueba' }
		});
		if (response.statusCode !== 200) throw new Error(`approval failed: ${response.body}`);
	}
	const opened = await ctx.app.inject({ method: 'POST', url: `/admin/campaigns/${tenant.campaignId}/transition`, headers: auth, payload: { to: 'open' } });
	if (opened.statusCode !== 200) throw new Error(`open failed: ${opened.body}`);
}

export async function placeOrder(ctx: TestContext, tenant: TenantFixture, overrides: Record<string, unknown> = {}) {
	const response = await ctx.app.inject({ method: 'POST', url: '/checkout/orders', headers: headers(tenant), payload: checkoutBody(tenant, overrides) });
	if (response.statusCode !== 201) throw new Error(`checkout failed: ${response.body}`);
	const body = response.json() as { reference: string; accessCode: string; redirectUrl: string; totalMinor: number };
	return { ...body, checkoutId: checkoutIdOf(body.redirectUrl) };
}

/** The Mercado Pago order id in a checkout URL (the simulator's, like Mercado Pago's, carries `order_id`). */
export function checkoutIdOf(redirectUrl: string): string {
	return new URL(redirectUrl).searchParams.get('order_id')!;
}

/** A signed Mercado Pago notification, shaped like the docs: `?data.id=ORD...&type=order`. */
export function webhookRequest(tenant: TenantFixture, orderId: string, secret = tenant.webhookSecret, topic = 'order') {
	const requestId = randomUUID();
	const ts = '1793000000';
	return {
		method: 'POST' as const,
		url: `/webhooks/mercadopago/${tenant.id}?data.id=${orderId}&type=${topic}`,
		headers: { 'x-signature': `ts=${ts},v1=${signWebhook(secret, orderId, requestId, ts)}`, 'x-request-id': requestId },
		payload: { action: `${topic}.processed`, api_version: 'v1', type: topic, data: { id: orderId } }
	};
}

export async function orderByReference(ctx: TestContext, tenant: TenantFixture, reference: string) {
	const [order] = await ctx.db.withTenant(tenant.id, (tx) => tx.select().from(s.orders).where(eq(s.orders.reference, reference)));
	return order!;
}
