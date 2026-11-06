import { sha256Hex } from '@sortea/domain/server';
import type { PaymentProvider, ProviderCheckoutRequest, ProviderCredentials, ProviderPayment } from './provider';
import { ProviderError } from './provider';

/**
 * Local stand-in for Mercado Pago's Orders API. It keeps orders in memory and
 * is driven from the `/pago-simulado` page. Everything after the "payment"
 * (signed order notification, server-side order read, confirmation) runs
 * through the same code as production. Refused in production by configuration.
 *
 * Like the adapter, an order that took money reports the fees, net and release
 * date its payment would (`simulatedMoney`), and its id doubles as the payment
 * id the platform stores.
 */
export interface SimulatedOrder {
	readonly id: string;
	readonly accessToken: string;
	readonly request: ProviderCheckoutRequest;
	readonly createdAt: Date;
	/** What reading the order returns. */
	readonly facts: ProviderPayment;
}

export interface PaymentSimulator extends PaymentProvider {
	readonly orders: Map<string, SimulatedOrder>;
	/** A payment attempt on the order: approved (`processed`), rejected (`failed`) or pending (`processing`). */
	pay(orderId: string, outcome: 'approved' | 'rejected' | 'in_process'): ProviderPayment;
	setStatus(orderId: string, status: 'refunded' | 'charged_back' | 'approved'): ProviderPayment;
	/** Returns part of a processed order; it stays `processed`, like Mercado Pago. */
	refundPartially(orderId: string, amountMinor: number): ProviderPayment;
	/** Changes what the provider reports, to rehearse discrepancies. Test and demo use only. */
	tamper(
		orderId: string,
		changes: Partial<Pick<ProviderPayment, 'amountMinor' | 'currency' | 'collectorId' | 'feeMinor' | 'netMinor' | 'releaseDate' | 'releaseStatus'>>
	): ProviderPayment;
}

/** Mercado Pago's fee for Checkout Pro with money released at once in Argentina, in basis points (6.29%). */
export const SIMULATED_FEE_BASIS_POINTS = 629;

/** Plausible money of an approved payment: the seller pays the fee and the money is released at once. */
export function simulatedMoney(amountMinor: number, approvedAt: Date): Pick<ProviderPayment, 'feeMinor' | 'netMinor' | 'releaseDate' | 'releaseStatus'> {
	const feeMinor = Math.round((amountMinor * SIMULATED_FEE_BASIS_POINTS) / 10_000);
	return { feeMinor, netMinor: amountMinor - feeMinor, releaseDate: approvedAt, releaseStatus: 'released' };
}

/** Deterministic merchant id for a simulated account; the seed uses the same formula. */
export function simulatorCollectorId(accessToken: string): string {
	return `sim-${sha256Hex(accessToken).slice(0, 10)}`;
}

export function createPaymentSimulator(options: { webOrigin: string; now?: () => Date }): PaymentSimulator {
	const now = options.now ?? (() => new Date());
	const orders = new Map<string, SimulatedOrder>();

	const owned = (credentials: ProviderCredentials, order: SimulatedOrder) => credentials.accessToken === order.accessToken;

	function update(orderId: string, change: (facts: ProviderPayment) => Partial<ProviderPayment>): ProviderPayment {
		const order = orders.get(orderId);
		if (!order) throw new ProviderError('Order not found', 404);
		const facts = { ...order.facts, ...change(order.facts), updatedAt: now() };
		orders.set(orderId, { ...order, facts });
		return facts;
	}

	const outcomes = {
		approved: { status: 'processed', statusDetail: 'accredited' },
		rejected: { status: 'failed', statusDetail: 'rejected_by_issuer' },
		in_process: { status: 'processing', statusDetail: 'in_process' }
	} as const;

	return {
		name: 'mercadopago',
		orders,

		async createCheckout(credentials, request) {
			// The same idempotency key returns the same order, like X-Idempotency-Key.
			const id = `ORDSIM${sha256Hex(request.idempotencyKey).slice(0, 24).toUpperCase()}`;
			if (!orders.has(id)) {
				const at = now();
				const amountMinor = request.items.reduce((sum, item) => sum + item.unitPriceMinor * item.quantity, 0);
				orders.set(id, {
					id,
					accessToken: credentials.accessToken,
					request,
					createdAt: at,
					facts: {
						id,
						status: 'created',
						statusDetail: 'created',
						externalReference: request.orderReference,
						amountMinor,
						currency: request.items[0]?.currency ?? 'ARS',
						collectorId: simulatorCollectorId(credentials.accessToken),
						approvedAt: null,
						refundedMinor: 0,
						feeMinor: null,
						netMinor: null,
						releaseDate: null,
						releaseStatus: null,
						updatedAt: at,
						attempts: 0
					}
				});
			}
			const url = new URL('/pago-simulado', request.returnUrls.success);
			url.searchParams.set('order_id', id);
			return { id, redirectUrl: url.toString() };
		},

		async getOrder(credentials, orderId) {
			const order = orders.get(orderId);
			// Another tenant's token cannot read this order, like the real API.
			if (!order || !owned(credentials, order)) throw new ProviderError('Order not found', 404);
			return order.facts;
		},

		async searchOrders(credentials, search) {
			const matching = [...orders.values()]
				.filter((order) => owned(credentials, order))
				.filter((order) => order.createdAt >= search.createdFrom && order.createdAt <= search.createdTo)
				.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
			return { results: matching.slice(search.offset, search.offset + search.limit).map((order) => order.facts), total: matching.length };
		},

		async verifyAccount(credentials) {
			if (!credentials.accessToken.startsWith('TEST-')) throw new ProviderError('Simulator only accepts TEST- tokens', 401);
			return { collectorId: simulatorCollectorId(credentials.accessToken), nickname: 'SIMULADOR' };
		},

		pay(orderId, outcome) {
			return update(orderId, (facts) => {
				if (outcome !== 'approved') return { ...outcomes[outcome], attempts: facts.attempts + 1 };
				const approvedAt = now();
				return { ...outcomes.approved, approvedAt, ...simulatedMoney(facts.amountMinor, approvedAt), attempts: facts.attempts + 1 };
			});
		},

		setStatus(orderId, status) {
			return update(orderId, (facts) => {
				if (status === 'refunded') return { status, statusDetail: 'refunded', refundedMinor: facts.amountMinor };
				if (status === 'charged_back') return { status, statusDetail: 'settled' };
				const approvedAt = facts.approvedAt ?? now();
				// Approved again, it keeps the money it reported; refunds and chargebacks keep it too.
				return { ...outcomes.approved, approvedAt, ...(facts.feeMinor === null ? simulatedMoney(facts.amountMinor, approvedAt) : {}) };
			});
		},

		refundPartially(orderId, amountMinor) {
			return update(orderId, (facts) => {
				if (facts.status !== 'processed' || amountMinor <= 0 || facts.refundedMinor + amountMinor >= facts.amountMinor) {
					throw new ProviderError('Invalid partial refund', 400);
				}
				return { refundedMinor: facts.refundedMinor + amountMinor, statusDetail: 'partially_refunded' };
			});
		},

		tamper(orderId, changes) {
			return update(orderId, () => changes);
		}
	};
}
