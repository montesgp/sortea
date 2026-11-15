import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, gt, inArray, isNull, ne, or, schema as s, sql, type Tx } from '@sortea/db';
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
/** The document's own email and up to four others it bought with, the most recent ones (S4). */
const MAX_RECIPIENTS = 5;

const genericStartMessage = 'Si el documento tiene compras registradas, enviamos un código de 6 dígitos a cada email que usaste al comprar.';
const invalidCode = () => new ApiError(400, 'invalid_code', 'El código no es válido o venció. Pedí uno nuevo');

/**
 * Private lookup for buyers without accounts (FR-ENTRY-03, AC-07).
 *
 * Starting a lookup always answers the same way, whether or not the document
 * exists, so the endpoint cannot be used to learn who bought. Unknown
 * documents still get a challenge row; it simply can never be satisfied.
 *
 * A document that bought with several emails gets a code at each of them, each
 * its own, under one request (owner feedback 2026-11-15b S4). The code sent to
 * the contact's own email opens every purchase; one sent to another email opens
 * only the purchases made with that email, so typing someone else's document
 * next to your own email never shows theirs.
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
			const groupId = randomUUID();
			const expiresAt = new Date(deps.now().getTime() + CHALLENGE_TTL_MINUTES * 60_000);

			const challengeId = await deps.db.withTenant(tenant.id, async (tx) => {
				const contact = document.ok ? await findContact(tx, document.type, document.number) : null;
				const recent = contact ? await recentChallenges(tx, contact.id, deps.now()) : 0;
				const deliver = contact && recent < 3;
				// Null is the contact's own email; the others come from its orders.
				const recipients: (string | null)[] = deliver ? [null, ...(await otherEmails(tx, contact.id, contact.email, MAX_RECIPIENTS - 1))] : [null];
				for (const [index, email] of recipients.entries()) {
					const code = generateOtp();
					// The first code carries the request's id, the one the buyer gets back.
					const id = index === 0 ? groupId : randomUUID();
					await tx.insert(s.lookupChallenges).values({
						id,
						organizationId: tenant.id,
						contactId: deliver ? contact.id : null,
						groupId,
						email,
						codeHash: hashWithPepper(pepper, code),
						expiresAt
					});
					if (deliver) {
						// The code travels sealed through the outbox and is opened only by the worker that emails it.
						const sealedCode = sealSecret(deps.keyRing, code, `otp:${id}`);
						await enqueue(tx, tenant.id, 'lookup.otp', `lookup.otp:${id}`, { challengeId: id, contactId: contact.id, sealedCode });
					}
				}
				return groupId;
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
				// Every code of the request; codes created before requests had several stand alone.
				const codes = await tx
					.select()
					.from(s.lookupChallenges)
					.where(or(eq(s.lookupChallenges.groupId, body.challengeId), eq(s.lookupChallenges.id, body.challengeId)))
					.for('update');
				if (codes.length === 0) return false;
				// The five attempts are the request's, whichever code they try.
				const attempts = Math.max(...codes.map((code) => code.attempts));
				if (codes.some((code) => code.consumedAt || code.expiresAt <= now) || attempts >= MAX_ATTEMPTS) return false;
				const typed = hashWithPepper(pepper, body.code);
				const challenge = codes.find((code) => code.contactId && safeEqualHex(code.codeHash, typed));
				const ids = codes.map((code) => code.id);
				if (!challenge?.contactId) {
					await tx.update(s.lookupChallenges).set({ attempts: attempts + 1 }).where(inArray(s.lookupChallenges.id, ids));
					return false;
				}
				// One code used closes the request: the others can no longer open it.
				await tx.update(s.lookupChallenges).set({ consumedAt: now, attempts: attempts + 1 }).where(inArray(s.lookupChallenges.id, ids));
				if (!challenge.email) {
					await tx
						.update(s.contacts)
						.set({ emailVerifiedAt: now })
						.where(and(eq(s.contacts.id, challenge.contactId), isNull(s.contacts.emailVerifiedAt)));
				}
				await createSession(tx, tenant, pepper, challenge.contactId, null, token, now, challenge.email);
				await audit(tx, { organizationId: tenant.id, actorType: 'buyer', action: 'lookup.otp_verified', targetType: 'contact', targetId: challenge.contactId, metadata: { scope: challenge.email ? 'email' : 'contact' } });
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
				.where(and(eq(s.orders.contactId, session.contactId), session.orderId ? eq(s.orders.id, session.orderId) : undefined, madeWith(session.email)))
				.orderBy(asc(s.orders.createdAt));
			const orderIds = orders.map((order) => order.id);
			const [items, assets, entries] = orderIds.length
				? await Promise.all([
						tx.select().from(s.orderItems).where(inArray(s.orderItems.orderId, orderIds)),
						tx
							.select({ asset: s.productAssets, orderId: s.orderItems.orderId })
							.from(s.orderItems)
							.innerJoin(s.productAssets, eq(s.productAssets.productId, s.orderItems.productId))
							.where(inArray(s.orderItems.orderId, orderIds))
							// One link per file, each product's files together and in their order (owner-feedback-2026-11-11b, S2).
							.orderBy(asc(s.productAssets.productId), asc(s.productAssets.position), asc(s.productAssets.createdAt)),
						tx
							.select({ entry: s.participationEntries, campaign: { title: s.campaigns.title, slug: s.campaigns.slug, status: s.campaigns.status, entryDigits: s.campaigns.entryDigits } })
							.from(s.participationEntries)
							.innerJoin(s.campaigns, eq(s.campaigns.id, s.participationEntries.campaignId))
							.where(inArray(s.participationEntries.orderId, orderIds))
							.orderBy(asc(s.participationEntries.entryNumber))
					])
				: [[], [], []];

			const campaigns = new Map<string, { slug: string; title: string; status: string; entryDigits: number; entries: { number: number; status: string }[] }>();
			for (const { entry, campaign } of entries) {
				const group = campaigns.get(campaign.slug) ?? { ...campaign, entries: [] };
				group.entries.push({ number: entry.entryNumber, status: entry.status });
				campaigns.set(campaign.slug, group);
			}
			// The coupons of each order with their campaign (owner feedback 2026-11-11b, S9); null before they are assigned.
			const couponsOf = (orderId: string) => {
				const own = entries.filter(({ entry }) => entry.orderId === orderId);
				const first = own[0];
				return first
					? { campaign: first.campaign.title, entryDigits: first.campaign.entryDigits, entries: own.map(({ entry }) => ({ number: entry.entryNumber, status: entry.status })) }
					: null;
			};
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
							: [],
					coupons: couponsOf(order.id)
				})),
				campaigns: [...campaigns.values()]
			};
		});
	});

	app.post('/lookup/downloads', { config: { rateLimit: { max: 30, timeWindow: '10 minutes', keyGenerator: (request) => `lookup-downloads:${clientKey(request)}` } } }, async (request) => {
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
						madeWith(session.email),
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
		.select({ id: s.contacts.id, email: s.contacts.email })
		.from(s.contactIdentifiers)
		.innerJoin(s.contacts, eq(s.contacts.id, s.contactIdentifiers.contactId))
		.where(and(eq(s.contactIdentifiers.documentType, type), eq(s.contactIdentifiers.documentNumber, number)));
	return row ?? null;
}

/**
 * The other emails the contact bought with, the most recently used first, at most `limit`.
 * Order emails are stored normalized at checkout.
 */
async function otherEmails(tx: Tx, contactId: string, contactEmail: string, limit: number): Promise<string[]> {
	const email = sql<string>`${s.orders.buyer}->>'email'`;
	const rows = await tx
		.select({ email, lastUsed: sql<Date>`max(${s.orders.createdAt})` })
		.from(s.orders)
		.where(and(eq(s.orders.contactId, contactId), ne(email, contactEmail)))
		.groupBy(email)
		.orderBy(desc(sql`max(${s.orders.createdAt})`), asc(email))
		.limit(limit);
	return rows.map((row) => row.email);
}

/** The orders a session may see: all of the contact's, or those made with the email its code went to (S4). */
function madeWith(email: string | null) {
	return email ? eq(sql`${s.orders.buyer}->>'email'`, email) : undefined;
}

/**
 * Caps emails per contact so the lookup cannot be used to flood someone's inbox: requests, not
 * codes, are counted, used or not. A request closes with any of its codes, so someone who bought
 * with another person's document and their own email could otherwise verify their own code and
 * start again without end (native review of the 2026-11-15b S4 change).
 */
async function recentChallenges(tx: Tx, contactId: string, now: Date): Promise<number> {
	const rows = await tx
		.select({ id: s.lookupChallenges.id })
		.from(s.lookupChallenges)
		.where(
			and(
				eq(s.lookupChallenges.contactId, contactId),
				isNull(s.lookupChallenges.email),
				gt(s.lookupChallenges.createdAt, new Date(now.getTime() - 60 * 60_000))
			)
		);
	return rows.length;
}

async function createSession(tx: Tx, tenant: Tenant, pepper: string, contactId: string, orderId: string | null, token: string, now: Date, email: string | null = null) {
	await tx.insert(s.lookupSessions).values({
		organizationId: tenant.id,
		contactId,
		orderId,
		email,
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

declare module 'fastify' {
	interface FastifyRequest {
		/** Set once the internal token proved the request came through the web tier. */
		trustedRelay: boolean;
	}
}

/**
 * Rate limit key: the client IP relayed by the web tier, never a value the browser sets directly.
 * The relayed header counts only on requests that carried the internal token; on public routes
 * (webhooks) anyone could set it to get a fresh bucket each time (owner feedback 2026-11-15b S11).
 */
export function clientKey(request: FastifyRequest): string {
	const relayed = request.headers['x-client-ip'];
	return request.trustedRelay && typeof relayed === 'string' && relayed ? relayed : request.ip;
}
