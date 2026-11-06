/**
 * Payment and order state (FR-PAY-03, FR-PAY-04). The order state only moves
 * from server-verified payment data; never from a browser redirect (AC-03).
 */
export const paymentStatuses = [
	'pending',
	'in_process',
	'approved',
	'rejected',
	'cancelled',
	'refunded',
	'charged_back'
] as const;
export type PaymentStatus = (typeof paymentStatuses)[number];

export const orderStatuses = [
	'pending_payment',
	'paid',
	'payment_failed',
	'refunded',
	'charged_back',
	'expired'
] as const;
export type OrderStatus = (typeof orderStatuses)[number];

/**
 * Maps the `status` of a Mercado Pago order (Orders API, Checkout Pro) to the
 * internal vocabulary. The order status sums up its payments:
 *
 * | Order status      | Payment status | Note                                                  |
 * | ----------------- | -------------- | ----------------------------------------------------- |
 * | `created`         | `pending`      | nobody paid yet                                       |
 * | `action_required` | `pending`      | e.g. waiting for a capture or a ticket payment        |
 * | `processing`      | `in_process`   | `in_process`, `pending_review_manual`                 |
 * | `processed`       | `approved`     | `accredited`; `partially_refunded` stays approved     |
 * | `failed`          | `rejected`     | any rejection detail                                  |
 * | `canceled`        | `cancelled`    | cancelled or expired without a payment                |
 * | `expired`         | `cancelled`    | there is no internal `expired` payment status         |
 * | `refunded`        | `refunded`     | full refund                                           |
 * | `charged_back`    | `charged_back` | any chargeback detail                                 |
 *
 * Anything else, Payments API words included, is `pending`: unknown never approves.
 */
export function mapMercadoPagoStatus(status: string): PaymentStatus {
	switch (status) {
		case 'processed':
			return 'approved';
		case 'processing':
			return 'in_process';
		case 'failed':
			return 'rejected';
		case 'canceled':
		case 'expired':
			return 'cancelled';
		case 'refunded':
			return 'refunded';
		case 'charged_back':
			return 'charged_back';
		default:
			return 'pending';
	}
}

export type OrderEffect =
	/** First confirmation: deliver goods, allocate participations, notify. */
	| 'confirm'
	/** Money returned: revoke participations through the ledger, never delete them. */
	| 'revoke'
	| 'none';

export interface OrderTransition {
	readonly status: OrderStatus;
	readonly changed: boolean;
	readonly effect: OrderEffect;
}

export function applyPaymentToOrder(current: OrderStatus, payment: PaymentStatus): OrderTransition {
	const stay: OrderTransition = { status: current, changed: false, effect: 'none' };

	switch (current) {
		case 'pending_payment':
		case 'payment_failed':
		case 'expired':
			if (payment === 'approved') return { status: 'paid', changed: true, effect: 'confirm' };
			if ((payment === 'rejected' || payment === 'cancelled') && current === 'pending_payment') {
				return { status: 'payment_failed', changed: true, effect: 'none' };
			}
			return stay;
		case 'paid':
			if (payment === 'refunded') return { status: 'refunded', changed: true, effect: 'revoke' };
			if (payment === 'charged_back') return { status: 'charged_back', changed: true, effect: 'revoke' };
			return stay;
		case 'refunded':
		case 'charged_back':
			return stay;
	}
}

/**
 * Checks that the payment the provider reports really belongs to this order:
 * same reference, same amount and currency, and the tenant's own merchant.
 */
export interface VerifiedPaymentFacts {
	readonly externalReference: string | null;
	readonly amountMinor: number;
	readonly currency: string;
	readonly collectorId: string | null;
}

export type PaymentMatch =
	| { ok: true }
	| { ok: false; reason: 'reference_mismatch' | 'amount_mismatch' | 'currency_mismatch' | 'merchant_mismatch' };

/**
 * `paymentAccountId` is the account that notified and returned the payment. An
 * order is paid only into the account it was created with; orders created before
 * accounts were recorded (`paymentAccountId` null) rely on the collector check.
 */
export function matchPaymentToOrder(
	facts: VerifiedPaymentFacts,
	order: { reference: string; totalMinor: number; currency: string; paymentAccountId?: string | null },
	expectedCollectorId: string | null,
	paymentAccountId: string | null = null
): PaymentMatch {
	if (facts.externalReference !== order.reference) return { ok: false, reason: 'reference_mismatch' };
	if (facts.currency !== order.currency) return { ok: false, reason: 'currency_mismatch' };
	if (facts.amountMinor !== order.totalMinor) return { ok: false, reason: 'amount_mismatch' };
	if (expectedCollectorId && facts.collectorId !== expectedCollectorId) {
		return { ok: false, reason: 'merchant_mismatch' };
	}
	if (paymentAccountId && order.paymentAccountId && order.paymentAccountId !== paymentAccountId) {
		return { ok: false, reason: 'merchant_mismatch' };
	}
	return { ok: true };
}
