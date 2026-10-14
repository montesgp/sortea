import { and, asc, eq, gt, inArray, isNull, schema as s, type Tx } from '@sortea/db';
import { lookupStartSchema, lookupVerifySchema, normalizeDocument, receiptLookupSchema } from '@sortea/domain';
import {
	downloadTokenHash,
	generateOtp,
	generateToken,
	hashWithPepper,
	lookupSessionTokenHash,
	safeEqualHex,
	sealSecret
} from '@sortea/domain/server';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { audit } from '../lib/audit';
import { ApiError, parse } from '../lib/errors';
import { enqueue } from '../lib/outbox';
import { requireTenant, type Tenant } from '../lib/tenant';

const CHALLENGE_TTL_MINUTES = 10;
const SESSION_TTL_MINUTES = 30;
const MAX_ATTEMPTS = 5;
const GRANT_TTL_HOURS = 24;

const genericStartMessage = 'Si el documento tiene compras registradas, enviamos un código de 6 dígitos al email de la compra.';
const invalidCode = () => new ApiError(400, 'invalid_code', 'El código no es válido o venció. Pedí uno nuevo');

/**
 * Private lookup for buyers without accounts (FR-ENTRY-03, AC-07).
 *
 * Starting a lookup always answers the same way, whether or not the document
 * exists, so the endpoint cannot be used to learn who bought. Unknown
 * documents still get a challenge row; it simply can never be satisfied.
 */
export async function lookupRoutes(app: FastifyInstance) {
	const { deps } = app;
	const pepper = deps.config.LOOKUP_PEPPER;

	app.post(
		'/lookup/start',
		{ config: { rateLimit: { max: 5, timeWindow: '15 minutes', keyGenerator: (request) => `lookup-start:${clientKey(request)}` } } },
		async (request) => {
			const tenant = await requireTenant(request);
			const body = parse(lookupStartSchema, request.body);
			const document = normalizeDocument(body.documentType, body.documentNumber);
			const code = generateOtp();
			const codeHash = hashWithPepper(pepper, code);

			const challengeId = await deps.db.withTenant(tenant.id, async (tx) => {
				const contact = document.ok ? await findContact(tx, document.type, document.number) : null;
				const recent = contact ? await recentChallenges(tx, contact.id, deps.now()) : 0;
				const deliver = contact && recent < 3;
				const [challenge] = await tx
					.insert(s.lookupChallenges)
					.values({
						organizationId: tenant.id,
						contactId: deliver ? contact.id : null,
						codeHash,
						expiresAt: new Date(deps.now().getTime() + CHALLENGE_TTL_MINUTES * 60_000)
					})
					.returning({ id: s.lookupChallenges.id });
				if (deliver) {
					// The code travels sealed through the outbox and is opened only by the worker that emails it.
					const sealedCode = sealSecret(deps.keyRing, code, `otp:${challenge!.id}`);
					await enqueue(tx, tenant.id, 'lookup.otp', `lookup.otp:${challenge!.id}`, { challengeId: challenge!.id, contactId: contact.id, sealedCode });
				}
				return challenge!.id;
			});
			return { challengeId, message: genericStartMessage };
		}
	);

	app.post(
		'/lookup/verify',
		{ config: { rateLimit: { max: 10, timeWindow: '15 minutes', keyGenerator: (request) => `lookup-verify:${clientKey(request)}` } } },
		async (request) => {
			const tenant = await requireTenant(request);
			const body = parse(lookupVerifySchema, request.body);
			const token = generateToken();
			const now = deps.now();

			const ok = await deps.db.withTenant(tenant.id, async (tx) => {
				const [challenge] = await tx.select().from(s.lookupChallenges).where(eq(s.lookupChallenges.id, body.challengeId)).for('update');
				if (!challenge || challenge.consumedAt || challenge.expiresAt <= now || challenge.attempts >= MAX_ATTEMPTS) return false;
				const matches = safeEqualHex(challenge.codeHash, hashWithPepper(pepper, body.code));
				if (!matches || !challenge.contactId) {
					await tx.update(s.lookupChallenges).set({ attempts: challenge.attempts + 1 }).where(eq(s.lookupChallenges.id, challenge.id));
					return false;
				}
				await tx.update(s.lookupChallenges).set({ consumedAt: now, attempts: challenge.attempts + 1 }).where(eq(s.lookupChallenges.id, challenge.id));
				await tx
					.update(s.contacts)
					.set({ emailVerifiedAt: now })
					.where(and(eq(s.contacts.id, challenge.contactId), isNull(s.contacts.emailVerifiedAt)));
				await createSession(tx, tenant, pepper, challenge.contactId, null, token, now);
				await audit(tx, { organizationId: tenant.id, actorType: 'buyer', action: 'lookup.otp_verified', targetType: 'contact', targetId: challenge.contactId });
				return true;
			});
			if (!ok) throw invalidCode();
			return { token, expiresInSeconds: SESSION_TTL_MINUTES * 60 };
		}
	);

	/** Access with the receipt reference and code printed on the purchase confirmation; scoped to that order. */
	app.post(
		'/lookup/receipt',
		{ config: { rateLimit: { max: 10, timeWindow: '15 minutes', keyGenerator: (request) => `lookup-receipt:${clientKey(request)}` } } },
		async (request) => {
			const tenant = await requireTenant(request);
			const body = parse(receiptLookupSchema, request.body);
			const token = generateToken();
			const ok = await deps.db.withTenant(tenant.id, async (tx) => {
				const [order] = await tx.select().from(s.orders).where(eq(s.orders.reference, body.reference));
				if (!order || !safeEqualHex(order.accessCodeHash, hashWithPepper(pepper, body.accessCode))) return false;
				await createSession(tx, tenant, pepper, order.contactId, order.id, token, deps.now());
				return true;
			});
			if (!ok) throw new ApiError(404, 'order_not_found', 'No encontramos una compra con esos datos');
			return { token, expiresInSeconds: SESSION_TTL_MINUTES * 60 };
		}
	);

	app.get('/lookup/me', async (request) => {
		const tenant = await requireTenant(request);
		return deps.db.withTenant(tenant.id, async (tx) => {
			const session = await requireSession(tx, request, pepper, deps.now());
			const [contact] = await tx.select().from(s.contacts).where(eq(s.contacts.id, session.contactId));
			const orders = await tx
				.select()
				.from(s.orders)
				.where(and(eq(s.orders.contactId, session.contactId), session.orderId ? eq(s.orders.id, session.orderId) : undefined))
				.orderBy(asc(s.orders.createdAt));
			const orderIds = orders.map((order) => order.id);
			const [items, assets, entries] = orderIds.length
				? await Promise.all([
						tx.select().from(s.orderItems).where(inArray(s.orderItems.orderId, orderIds)),
						tx
							.select({ asset: s.productAssets, orderId: s.orderItems.orderId })
							.from(s.orderItems)
							.innerJoin(s.productAssets, eq(s.productAssets.productId, s.orderItems.productId))
							.where(inArray(s.orderItems.orderId, orderIds)),
						tx
							.select({ entry: s.participationEntries, campaign: { title: s.campaigns.title, slug: s.campaigns.slug, status: s.campaigns.status } })
							.from(s.participationEntries)
							.innerJoin(s.campaigns, eq(s.campaigns.id, s.participationEntries.campaignId))
							.where(inArray(s.participationEntries.orderId, orderIds))
							.orderBy(asc(s.participationEntries.entryNumber))
					])
				: [[], [], []];

			const campaigns = new Map<string, { slug: string; title: string; status: string; entries: { number: number; status: string }[] }>();
			for (const { entry, campaign } of entries) {
				const group = campaigns.get(campaign.slug) ?? { ...campaign, entries: [] };
				group.entries.push({ number: entry.entryNumber, status: entry.status });
				campaigns.set(campaign.slug, group);
			}
			return {
				holder: { firstName: contact?.firstName ?? '', scope: session.orderId ? 'order' : 'contact' },
				orders: orders.map((order) => ({
					id: order.id,
					reference: order.reference,
					status: order.status,
					totalMinor: order.totalMinor,
					currency: order.currency,
					createdAt: order.createdAt,
					items: items.filter((item) => item.orderId === order.id).map((item) => ({ name: item.name, quantity: item.quantity, kind: item.kind })),
					downloads:
						order.status === 'paid'
							? assets.filter((row) => row.orderId === order.id).map((row) => ({ assetId: row.asset.id, filename: row.asset.filename }))
							: []
				})),
				campaigns: [...campaigns.values()]
			};
		});
	});

	app.post('/lookup/downloads', async (request) => {
		const tenant = await requireTenant(request);
		const body = parse(z.object({ orderId: z.uuid(), assetId: z.uuid() }), request.body);
		const token = generateToken();
		await deps.db.withTenant(tenant.id, async (tx) => {
			const session = await requireSession(tx, request, pepper, deps.now());
			if (session.orderId && session.orderId !== body.orderId) throw new ApiError(404, 'not_found', 'Archivo no disponible');
			const [row] = await tx
				.select({ orderId: s.orders.id })
				.from(s.orders)
				.innerJoin(s.orderItems, eq(s.orderItems.orderId, s.orders.id))
				.innerJoin(s.productAssets, eq(s.productAssets.productId, s.orderItems.productId))
				.where(
					and(
						eq(s.orders.id, body.orderId),
						eq(s.orders.contactId, session.contactId),
						eq(s.orders.status, 'paid'),
						eq(s.productAssets.id, body.assetId)
					)
				);
			if (!row) throw new ApiError(404, 'not_found', 'Archivo no disponible');
			await tx.insert(s.downloadGrants).values({
				organizationId: tenant.id,
				orderId: body.orderId,
				productAssetId: body.assetId,
				tokenHash: downloadTokenHash(pepper, token),
				expiresAt: new Date(deps.now().getTime() + GRANT_TTL_HOURS * 3_600_000)
			});
		});
		return { token };
	});
}

async function findContact(tx: Tx, type: 'DNI' | 'CUIT' | 'PASSPORT', number: string) {
	const [row] = await tx
		.select({ id: s.contacts.id })
		.from(s.contactIdentifiers)
		.innerJoin(s.contacts, eq(s.contacts.id, s.contactIdentifiers.contactId))
		.where(and(eq(s.contactIdentifiers.documentType, type), eq(s.contactIdentifiers.documentNumber, number)));
	return row ?? null;
}

/** Caps emails per contact so the lookup cannot be used to flood someone's inbox. */
async function recentChallenges(tx: Tx, contactId: string, now: Date): Promise<number> {
	const rows = await tx
		.select({ id: s.lookupChallenges.id })
		.from(s.lookupChallenges)
		.where(and(eq(s.lookupChallenges.contactId, contactId), gt(s.lookupChallenges.createdAt, new Date(now.getTime() - 60 * 60_000)), isNull(s.lookupChallenges.consumedAt)));
	return rows.length;
}

async function createSession(tx: Tx, tenant: Tenant, pepper: string, contactId: string, orderId: string | null, token: string, now: Date) {
	await tx.insert(s.lookupSessions).values({
		organizationId: tenant.id,
		contactId,
		orderId,
		tokenHash: lookupSessionTokenHash(pepper, token),
		expiresAt: new Date(now.getTime() + SESSION_TTL_MINUTES * 60_000)
	});
}

async function requireSession(tx: Tx, request: FastifyRequest, pepper: string, now: Date) {
	const token = request.headers['x-lookup-token'];
	if (typeof token !== 'string' || token.length < 20) throw new ApiError(401, 'lookup_session_required', 'Volvé a verificar tu identidad');
	const [session] = await tx.select().from(s.lookupSessions).where(eq(s.lookupSessions.tokenHash, lookupSessionTokenHash(pepper, token)));
	if (!session || session.expiresAt <= now) throw new ApiError(401, 'lookup_session_required', 'Tu sesión de consulta venció. Verificá de nuevo');
	return session;
}

/** Rate limit key: the client IP relayed by the web tier, never a value the browser sets directly. */
export function clientKey(request: FastifyRequest): string {
	const relayed = request.headers['x-client-ip'];
	return typeof relayed === 'string' && relayed ? relayed : request.ip;
}
