import { and, count, eq, publishOpsEvent, schema as s, sql, type Tx } from '@sortea/db';
import {
	acceptsParticipations,
	applyPaymentToOrder,
	computeEntryAllocation,
	mapMercadoPagoStatus,
	matchPaymentToOrder,
	remainingCoupons,
	type OrderStatus
} from '@sortea/domain';
import { holderPseudonym } from '@sortea/domain/server';
import { audit } from '../lib/audit';
import { campaignGate, reservedCoupons } from '../lib/campaign-state';
import { enqueue } from '../lib/outbox';
import type { ProviderPayment } from './provider';

export type ConfirmationOutcome =
	| 'unknown_order'
	| 'reference_mismatch'
	| 'amount_mismatch'
	| 'currency_mismatch'
	| 'merchant_mismatch'
	| 'no_change'
	| OrderStatus;

export interface ConfirmationContext {
	readonly organizationId: string;
	readonly expectedCollectorId: string | null;
	readonly pseudonymPepper: string;
	/** The API's COMPLIANCE_DEMO setting (ADR 0013). */
	readonly complianceDemo: boolean;
	readonly now: Date;
}

/**
 * Applies a payment that was read from the provider API (never from a
 * webhook body or a browser redirect) to its order, inside one transaction:
 * payment row, order status, participations, stock and outbox (FR-PAY-03).
 *
 * Idempotency has three layers: the order row is locked, the payment row is
 * unique per provider id, and entry allocation is unique per order. Ten copies
 * of the same webhook therefore confirm the order exactly once (AC-01).
 */
export async function applyVerifiedPayment(tx: Tx, context: ConfirmationContext, payment: ProviderPayment): Promise<ConfirmationOutcome> {
	if (!payment.externalReference) return 'unknown_order';
	const [order] = await tx
		.select()
		.from(s.orders)
		.where(eq(s.orders.reference, payment.externalReference))
		.for('update');
	if (!order) return 'unknown_order';

	const match = matchPaymentToOrder(
		{ externalReference: payment.externalReference, amountMinor: payment.amountMinor, currency: payment.currency, collectorId: payment.collectorId },
		{ reference: order.reference, totalMinor: order.totalMinor, currency: order.currency },
		context.expectedCollectorId
	);
	if (!match.ok) {
		await audit(tx, {
			organizationId: context.organizationId,
			actorType: 'provider',
			action: 'payment.rejected_mismatch',
			targetType: 'order',
			targetId: order.id,
			metadata: { reason: match.reason, providerPaymentId: payment.id, amountMinor: payment.amountMinor, currency: payment.currency }
		});
		// The dashboard counts these as an alert.
		await publishOpsEvent(tx, context.organizationId, 'order.updated', order.id);
		return match.reason;
	}

	const status = mapMercadoPagoStatus(payment.status);
	const latest = { status, statusDetail: payment.statusDetail, approvedAt: payment.approvedAt, ...providerFinancials(payment) };
	await tx
		.insert(s.payments)
		.values({
			organizationId: context.organizationId,
			orderId: order.id,
			provider: 'mercadopago',
			providerPaymentId: payment.id,
			amountMinor: payment.amountMinor,
			currency: payment.currency,
			collectorId: payment.collectorId,
			...latest,
			updatedAt: context.now
		})
		.onConflictDoUpdate({
			target: [s.payments.organizationId, s.payments.provider, s.payments.providerPaymentId],
			set: { ...latest, updatedAt: context.now }
		});

	const transition = applyPaymentToOrder(order.status, status);
	if (!transition.changed) return 'no_change';

	const approvedAt = payment.approvedAt ?? context.now;
	await tx
		.update(s.orders)
		.set({ status: transition.status, paidAt: transition.effect === 'confirm' ? approvedAt : order.paidAt, updatedAt: context.now })
		.where(eq(s.orders.id, order.id));

	if (transition.effect === 'confirm') {
		const entries = await allocateEntries(tx, context, order, approvedAt, payment.id);
		await decrementStock(tx, context, order.id);
		await enqueue(tx, context.organizationId, 'order.paid', `order.paid:${order.id}`, { orderId: order.id, entries });
	}
	if (transition.effect === 'revoke') {
		const voided = await voidEntries(tx, context, order.id, transition.status);
		await enqueue(tx, context.organizationId, 'order.revoked', `order.revoked:${order.id}`, { orderId: order.id, voided });
	}
	await audit(tx, {
		organizationId: context.organizationId,
		actorType: 'provider',
		action: `order.${transition.status}`,
		targetType: 'order',
		targetId: order.id,
		metadata: { providerPaymentId: payment.id }
	});
	await publishOpsEvent(tx, context.organizationId, 'order.updated', order.id);
	return transition.status;
}

/** Fees, net, refunds and release as the provider reports them (FR-PAY-06). */
export function providerFinancials(payment: ProviderPayment) {
	return {
		feeMinor: payment.feeMinor,
		netMinor: payment.netMinor,
		refundedMinor: payment.refundedMinor,
		releaseDate: payment.releaseDate,
		releaseStatus: payment.releaseStatus,
		providerUpdatedAt: payment.updatedAt
	};
}

type OrderRow = typeof s.orders.$inferSelect;

async function allocateEntries(tx: Tx, context: ConfirmationContext, order: OrderRow, approvedAt: Date, providerPaymentId: string): Promise<number> {
	if (!order.campaignId || !order.ruleVersionId) return 0;
	const [campaign] = await tx.select().from(s.campaigns).where(eq(s.campaigns.id, order.campaignId)).for('update');
	if (!campaign) return 0;

	// Payments that settle after the close or outside an authorized, open
	// campaign keep the purchase but create no participations (published rule).
	const gate = await campaignGate(tx, campaign, context.complianceDemo);
	if (!acceptsParticipations(campaign.status, gate, campaign, approvedAt)) {
		await audit(tx, {
			organizationId: context.organizationId,
			actorType: 'system',
			action: 'entries.not_allocated',
			targetType: 'order',
			targetId: order.id,
			metadata: { campaignStatus: campaign.status, gateAllowed: gate.allowed }
		});
		return 0;
	}

	const [rule] = await tx
		.select()
		.from(s.campaignRuleVersions)
		.where(and(eq(s.campaignRuleVersions.id, order.ruleVersionId), eq(s.campaignRuleVersions.status, 'locked')));
	if (!rule) {
		// The rules the order was placed under were superseded by an announced version (AC-08).
		await audit(tx, {
			organizationId: context.organizationId,
			actorType: 'system',
			action: 'entries.not_allocated',
			targetType: 'order',
			targetId: order.id,
			metadata: { reason: 'rule_superseded', ruleVersionId: order.ruleVersionId }
		});
		return 0;
	}

	const items = await tx.select().from(s.orderItems).where(eq(s.orderItems.orderId, order.id));
	const [already] = await tx
		.select({ value: count() })
		.from(s.participationEntries)
		.where(
			and(
				eq(s.participationEntries.campaignId, campaign.id),
				eq(s.participationEntries.contactId, order.contactId),
				eq(s.participationEntries.status, 'eligible')
			)
		);
	const entryCount = computeEntryAllocation(rule.entryRule, items, already?.value ?? 0);
	if (entryCount === 0) return 0;

	// The order is no longer pending, so its own reservation is not counted here; others still are.
	const remaining = remainingCoupons({
		entryDigits: campaign.entryDigits,
		nextEntryNumber: campaign.nextEntryNumber,
		reserved: await reservedCoupons(tx, campaign.id, context.now)
	});
	if (entryCount > remaining) {
		await flagPoolExhausted(tx, context, order, providerPaymentId, entryCount, remaining);
		return 0;
	}

	const allocated = await tx
		.insert(s.entryAllocations)
		.values({ organizationId: context.organizationId, campaignId: campaign.id, orderId: order.id, ruleVersionId: rule.id, entryCount })
		.onConflictDoNothing({ target: s.entryAllocations.orderId })
		.returning({ id: s.entryAllocations.id });
	if (allocated.length === 0) return 0;

	const first = campaign.nextEntryNumber;
	await tx
		.update(s.campaigns)
		.set({ nextEntryNumber: sql`${s.campaigns.nextEntryNumber} + ${entryCount}` })
		.where(eq(s.campaigns.id, campaign.id));
	const pseudonym = holderPseudonym(context.pseudonymPepper, campaign.id, order.contactId);
	const entries = await tx
		.insert(s.participationEntries)
		.values(
			Array.from({ length: entryCount }, (_, index) => ({
				organizationId: context.organizationId,
				campaignId: campaign.id,
				entryNumber: first + index,
				contactId: order.contactId,
				orderId: order.id,
				holderPseudonym: pseudonym
			}))
		)
		.returning({ id: s.participationEntries.id });
	await tx.insert(s.entryLedgerEvents).values(
		entries.map((entry) => ({
			organizationId: context.organizationId,
			campaignId: campaign.id,
			entryId: entry.id,
			event: 'allocated' as const,
			reason: `Pago aprobado de la orden ${order.reference}`,
			orderId: order.id
		}))
	);
	return entryCount;
}

/**
 * A paid order that no longer fits in the pool (its reservation expired, ADR 0014 §1): the
 * purchase stands, no number outside the pool is ever allocated, and finance gets a critical
 * reconciliation item to refund it.
 */
async function flagPoolExhausted(tx: Tx, context: ConfirmationContext, order: OrderRow, providerPaymentId: string, requested: number, remaining: number) {
	await audit(tx, {
		organizationId: context.organizationId,
		actorType: 'system',
		action: 'entries.pool_exhausted',
		targetType: 'order',
		targetId: order.id,
		metadata: { campaignId: order.campaignId, requested, remaining, providerPaymentId }
	});
	await tx
		.insert(s.reconciliationItems)
		.values({
			organizationId: context.organizationId,
			kind: 'pool_exhausted',
			severity: 'critical',
			fingerprint: `pool_exhausted:${order.id}`,
			providerPaymentId,
			orderReference: order.reference,
			orderId: order.id,
			expected: { entries: requested, amountMinor: order.totalMinor },
			observed: { remaining },
			firstSeenAt: context.now,
			lastSeenAt: context.now
		})
		.onConflictDoNothing();
	await publishOpsEvent(tx, context.organizationId, 'reconciliation.updated', order.id);
}

async function voidEntries(tx: Tx, context: ConfirmationContext, orderId: string, reason: string): Promise<number> {
	const voided = await tx
		.update(s.participationEntries)
		.set({ status: 'void' })
		.where(and(eq(s.participationEntries.orderId, orderId), eq(s.participationEntries.status, 'eligible')))
		.returning({ id: s.participationEntries.id, campaignId: s.participationEntries.campaignId });
	if (voided.length > 0) {
		await tx.insert(s.entryLedgerEvents).values(
			voided.map((entry) => ({
				organizationId: context.organizationId,
				campaignId: entry.campaignId,
				entryId: entry.id,
				event: 'voided' as const,
				reason: reason === 'refunded' ? 'Pago reintegrado' : 'Contracargo del pago',
				orderId
			}))
		);
	}
	return voided.length;
}

async function decrementStock(tx: Tx, context: ConfirmationContext, orderId: string): Promise<void> {
	const items = await tx.select().from(s.orderItems).where(eq(s.orderItems.orderId, orderId));
	for (const item of items) {
		const updated = await tx
			.update(s.productVariants)
			.set({ stock: sql`${s.productVariants.stock} - ${item.quantity}` })
			.where(and(eq(s.productVariants.id, item.variantId), sql`${s.productVariants.stock} is not null`, sql`${s.productVariants.stock} >= ${item.quantity}`))
			.returning({ id: s.productVariants.id });
		const [variant] = await tx.select({ stock: s.productVariants.stock }).from(s.productVariants).where(eq(s.productVariants.id, item.variantId));
		if (updated.length === 0 && variant?.stock !== null && variant?.stock !== undefined) {
			// Paid but no stock left: the money is real, so the order stands and a human resolves it.
			await audit(tx, {
				organizationId: context.organizationId,
				actorType: 'system',
				action: 'stock.oversold',
				targetType: 'order',
				targetId: orderId,
				metadata: { variantId: item.variantId, quantity: item.quantity }
			});
		}
	}
}
