import { and, asc, eq, inArray, lt, publishOpsEvent, schema as s, sql, type DatabaseHandle, type Tx } from '@sortea/db';
import { resolveTheme, type CurrencyCode } from '@sortea/domain';
import { downloadTokenHash, generateToken, openSecret, type KeyRing } from '@sortea/domain/server';
import { PermanentDeliveryError, type NotificationProvider } from './notifications';
import { orderPaidEmail, orderRevokedEmail, otpEmail, type Rendered } from './templates';

export const MAX_ATTEMPTS = 8;
const DOWNLOAD_HOURS = 72;
const STALE_LOCK_MINUTES = 5;

export interface WorkerDeps {
	readonly db: DatabaseHandle;
	readonly keyRing: KeyRing;
	readonly email: NotificationProvider;
	readonly lookupPepper: string;
	readonly webFallbackOrigin: string;
	readonly fromDomain: string;
	readonly workerId: string;
	readonly now: () => Date;
}

type OutboxRow = typeof s.outboxEvents.$inferSelect;

/** Exponential backoff: 30 s, 1 min, 2 min … capped at one hour. */
export function backoffSeconds(attempt: number): number {
	return Math.min(3600, 15 * 2 ** attempt);
}

/**
 * Claims due events across all organizations with SKIP LOCKED, so several
 * workers can run side by side. Events stuck in `processing` by a crashed
 * worker become claimable again after a few minutes.
 */
export async function claimBatch(deps: WorkerDeps, limit = 10): Promise<OutboxRow[]> {
	const now = deps.now();
	const staleBefore = new Date(now.getTime() - STALE_LOCK_MINUTES * 60_000);
	return deps.db.withPlatform((db) =>
		db.transaction(async (tx) => {
			const due = await tx
				.select({ id: s.outboxEvents.id })
				.from(s.outboxEvents)
				.where(
					sql`(${s.outboxEvents.status} = 'pending' and ${s.outboxEvents.availableAt} <= ${now.toISOString()}::timestamptz)
						or (${s.outboxEvents.status} = 'processing' and ${s.outboxEvents.lockedAt} < ${staleBefore.toISOString()}::timestamptz)`
				)
				.orderBy(asc(s.outboxEvents.createdAt))
				.limit(limit)
				.for('update', { skipLocked: true });
			if (due.length === 0) return [];
			return tx
				.update(s.outboxEvents)
				.set({ status: 'processing', lockedAt: now, lockedBy: deps.workerId, attempts: sql`${s.outboxEvents.attempts} + 1` })
				.where(inArray(s.outboxEvents.id, due.map((row) => row.id)))
				.returning();
		})
	);
}

export async function processEvent(deps: WorkerDeps, event: OutboxRow): Promise<'done' | 'retry' | 'dead'> {
	try {
		await deps.db.withTenant(event.organizationId, (tx) => handle(deps, tx, event));
		await finish(deps, event.id, { status: 'done', processedAt: deps.now(), lastError: null });
		return 'done';
	} catch (error) {
		const message = error instanceof Error ? error.message.slice(0, 500) : 'unknown error';
		if (event.attempts >= MAX_ATTEMPTS || error instanceof PermanentDeliveryError) {
			// Dead letter: kept for an operator, never silently dropped. A permanent refusal skips the retries.
			await finish(deps, event.id, { status: 'dead', lastError: message });
			return 'dead';
		}
		await finish(deps, event.id, {
			status: 'pending',
			lastError: message,
			availableAt: new Date(deps.now().getTime() + backoffSeconds(event.attempts) * 1000)
		});
		return 'retry';
	}
}

async function finish(deps: WorkerDeps, id: string, values: Partial<typeof s.outboxEvents.$inferInsert>) {
	await deps.db.withPlatform((db) => db.update(s.outboxEvents).set({ ...values, lockedAt: null, lockedBy: null }).where(eq(s.outboxEvents.id, id)));
}

async function handle(deps: WorkerDeps, tx: Tx, event: OutboxRow): Promise<void> {
	switch (event.topic) {
		case 'lookup.otp':
			return handleOtp(deps, tx, event);
		case 'order.paid':
			return handleOrderPaid(deps, tx, event);
		case 'order.revoked':
			return handleOrderRevoked(deps, tx, event);
		default:
			throw new Error(`Unknown outbox topic ${event.topic}`);
	}
}

async function brandFor(deps: WorkerDeps, tx: Tx, organizationId: string) {
	const [org] = await tx.select().from(s.organizations).where(eq(s.organizations.id, organizationId));
	const [domain] = await tx
		.select()
		.from(s.organizationDomains)
		.where(and(eq(s.organizationDomains.organizationId, organizationId), eq(s.organizationDomains.isPrimary, true)));
	const [theme] = await tx
		.select()
		.from(s.organizationThemes)
		.where(and(eq(s.organizationThemes.organizationId, organizationId), eq(s.organizationThemes.isActive, true)));
	const host = domain?.hostname ?? null;
	const local = !host || host === 'localhost' || host === '127.0.0.1' || host.endsWith('.localhost');
	const origin = local ? withHost(deps.webFallbackOrigin, host) : `https://${host}`;
	return {
		name: org!.name,
		accent: resolveTheme(theme?.tokens ?? {}).tokens.light.accent,
		origin,
		from: `${org!.name} <no-reply@${deps.fromDomain}>`
	};
}

function withHost(fallback: string, host: string | null): string {
	const url = new URL(fallback);
	if (host?.endsWith('.localhost')) url.hostname = host;
	return url.origin;
}

/**
 * Sends one email for an outbox event. Notification rows and attempts are
 * written in their own short transactions, so a failed send stays on record
 * even though the handler's transaction rolls back to trigger a retry. If an
 * earlier attempt already sent the email, the retry does not send it again.
 */
async function deliver(deps: WorkerDeps, event: OutboxRow, input: { contactId: string | null; to: string; template: string; from: string; message: Rendered }) {
	const organizationId = event.organizationId;
	const notification = await deps.db.withTenant(organizationId, async (tx) => {
		const [existing] = await tx.select().from(s.notifications).where(eq(s.notifications.outboxEventId, event.id));
		if (existing) return existing;
		const [created] = await tx
			.insert(s.notifications)
			.values({ organizationId, contactId: input.contactId, outboxEventId: event.id, template: input.template, locale: 'es-AR', toAddress: input.to })
			.returning();
		return created!;
	});
	if (notification.status === 'sent') return;

	try {
		const result = await deps.email.send({ from: input.from, to: input.to, ...input.message, idempotencyKey: `outbox:${event.id}` });
		await deps.db.withTenant(organizationId, async (tx) => {
			await tx.insert(s.notificationAttempts).values({ organizationId, notificationId: notification.id, attempt: event.attempts, ok: true });
			await tx.update(s.notifications).set({ status: 'sent', providerMessageId: result.messageId, sentAt: deps.now() }).where(eq(s.notifications.id, notification.id));
		});
	} catch (error) {
		const message = error instanceof Error ? error.message.slice(0, 300) : 'unknown';
		await deps.db.withTenant(organizationId, async (tx) => {
			await tx.insert(s.notificationAttempts).values({ organizationId, notificationId: notification.id, attempt: event.attempts, ok: false, error: message });
			await tx.update(s.notifications).set({ status: 'failed' }).where(eq(s.notifications.id, notification.id));
		});
		throw error;
	}
}

async function handleOtp(deps: WorkerDeps, tx: Tx, event: OutboxRow) {
	const payload = event.payload as { challengeId: string; contactId: string; sealedCode: string };
	const [challenge] = await tx.select().from(s.lookupChallenges).where(eq(s.lookupChallenges.id, payload.challengeId));
	// An expired or used code is not worth sending.
	if (!challenge || challenge.consumedAt || challenge.expiresAt <= deps.now()) return;
	const [contact] = await tx.select().from(s.contacts).where(eq(s.contacts.id, payload.contactId));
	if (!contact) return;
	const code = openSecret(deps.keyRing, payload.sealedCode, `otp:${payload.challengeId}`);
	const brand = await brandFor(deps, tx, event.organizationId);
	const minutes = Math.max(1, Math.round((challenge.expiresAt.getTime() - deps.now().getTime()) / 60_000));
	await deliver(deps, event, { contactId: contact.id, to: contact.email, template: 'lookup.otp', from: brand.from, message: otpEmail(brand, code, minutes) });
}

async function handleOrderPaid(deps: WorkerDeps, tx: Tx, event: OutboxRow) {
	const { orderId } = event.payload as { orderId: string };
	const [order] = await tx.select().from(s.orders).where(eq(s.orders.id, orderId));
	if (!order || order.status !== 'paid') return;
	const [alreadySent] = await tx
		.select()
		.from(s.notifications)
		.where(and(eq(s.notifications.outboxEventId, event.id), eq(s.notifications.status, 'sent')));
	if (alreadySent) return;

	const brand = await brandFor(deps, tx, event.organizationId);
	const items = await tx.select().from(s.orderItems).where(eq(s.orderItems.orderId, orderId));
	const assets = await tx
		.select({ asset: s.productAssets })
		.from(s.productAssets)
		.where(inArray(s.productAssets.productId, items.map((item) => item.productId)));
	const downloads = [];
	for (const { asset } of assets) {
		const token = generateToken();
		await tx.insert(s.downloadGrants).values({
			organizationId: event.organizationId,
			orderId,
			productAssetId: asset.id,
			tokenHash: downloadTokenHash(deps.lookupPepper, token),
			expiresAt: new Date(deps.now().getTime() + DOWNLOAD_HOURS * 3_600_000)
		});
		downloads.push({ filename: asset.filename, url: `${brand.origin}/descargas/${token}` });
	}
	const entries = await tx
		.select({ number: s.participationEntries.entryNumber, campaign: s.campaigns.title })
		.from(s.participationEntries)
		.innerJoin(s.campaigns, eq(s.campaigns.id, s.participationEntries.campaignId))
		.where(and(eq(s.participationEntries.orderId, orderId), eq(s.participationEntries.status, 'eligible')))
		.orderBy(asc(s.participationEntries.entryNumber));
	const groups = new Map<string, number[]>();
	for (const entry of entries) groups.set(entry.campaign, [...(groups.get(entry.campaign) ?? []), entry.number]);

	const message = orderPaidEmail(brand, {
		reference: order.reference,
		firstName: order.buyer.firstName,
		currency: order.currency as CurrencyCode,
		totalMinor: order.totalMinor,
		items: items.map((item) => ({ name: item.name, quantity: item.quantity, lineTotalMinor: item.lineTotalMinor })),
		downloads,
		entries: [...groups].map(([campaign, numbers]) => ({ campaign, numbers })),
		deliveryMethod: order.deliveryMethod,
		downloadHours: DOWNLOAD_HOURS
	});
	await deliver(deps, event, { contactId: order.contactId, to: order.buyer.email, template: 'order.paid', from: brand.from, message });
}

async function handleOrderRevoked(deps: WorkerDeps, tx: Tx, event: OutboxRow) {
	const { orderId } = event.payload as { orderId: string };
	const [order] = await tx.select().from(s.orders).where(eq(s.orders.id, orderId));
	if (!order || (order.status !== 'refunded' && order.status !== 'charged_back')) return;
	const brand = await brandFor(deps, tx, event.organizationId);
	await deliver(deps, event, {
		contactId: order.contactId,
		to: order.buyer.email,
		template: 'order.revoked',
		from: brand.from,
		message: orderRevokedEmail(brand, order.reference, order.status)
	});
}

/** System job: pending orders past their payment window become `expired` (a late approval still confirms them). */
export async function expireOrders(deps: WorkerDeps): Promise<number> {
	const rows = await deps.db.withPlatform((db) =>
		db.transaction(async (tx) => {
			const expired = await tx
				.update(s.orders)
				.set({ status: 'expired', updatedAt: deps.now() })
				.where(and(eq(s.orders.status, 'pending_payment'), lt(s.orders.expiresAt, deps.now())))
				.returning({ id: s.orders.id, organizationId: s.orders.organizationId });
			// One notice per organization is enough: dashboards re-read their snapshot.
			for (const organizationId of new Set(expired.map((row) => row.organizationId))) {
				await publishOpsEvent(tx, organizationId, 'order.updated');
			}
			return expired;
		})
	);
	return rows.length;
}

export const OPS_EVENT_RETENTION_DAYS = 7;

/** System job: change notices are only needed to resume a dashboard stream; older ones are dropped. */
export async function pruneOpsEvents(deps: WorkerDeps): Promise<number> {
	const before = new Date(deps.now().getTime() - OPS_EVENT_RETENTION_DAYS * 86_400_000);
	const rows = await deps.db.withPlatform((db) => db.delete(s.opsEvents).where(lt(s.opsEvents.createdAt, before)).returning({ sequence: s.opsEvents.sequence }));
	return rows.length;
}
