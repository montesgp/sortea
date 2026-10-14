import { sha256Hex } from '@sortea/domain/server';
import type { PaymentProvider, PreferenceRequest, ProviderCredentials, ProviderPayment } from './provider';
import { ProviderError } from './provider';

/**
 * Local stand-in for Mercado Pago. It keeps preferences and payments in memory
 * and is driven from the `/pago-simulado` page. Everything after the "payment"
 * (signed webhook, server-side payment lookup, confirmation) runs through the
 * same code as production. Refused in production by configuration.
 */
export interface SimulatedPreference {
	readonly id: string;
	readonly accessToken: string;
	readonly request: PreferenceRequest;
	readonly createdAt: Date;
}

type StoredPayment = ProviderPayment & { accessToken: string };

export interface PaymentSimulator extends PaymentProvider {
	readonly preferences: Map<string, SimulatedPreference>;
	readonly payments: Map<string, StoredPayment>;
	pay(preferenceId: string, outcome: 'approved' | 'rejected' | 'in_process'): ProviderPayment;
	setStatus(paymentId: string, status: 'refunded' | 'charged_back' | 'approved'): ProviderPayment;
	/** Returns part of an approved payment; the status stays `approved`, like Mercado Pago. */
	refundPartially(paymentId: string, amountMinor: number): ProviderPayment;
	/** Changes what the provider reports, to rehearse discrepancies. Test and demo use only. */
	tamper(paymentId: string, changes: Partial<Pick<ProviderPayment, 'amountMinor' | 'currency' | 'netMinor'>>): ProviderPayment;
}

/** Simulated merchant fee: 6.29 % (an illustrative rate, not a quote). */
export const SIMULATED_FEE_BASIS_POINTS = 629;

/** Deterministic merchant id for a simulated account; the seed uses the same formula. */
export function simulatorCollectorId(accessToken: string): string {
	return `sim-${sha256Hex(accessToken).slice(0, 10)}`;
}

export function createPaymentSimulator(options: { webOrigin: string; now?: () => Date }): PaymentSimulator {
	const now = options.now ?? (() => new Date());
	const preferences = new Map<string, SimulatedPreference>();
	const payments = new Map<string, StoredPayment>();
	let sequence = 9_000_000_000;

	const owned = (credentials: ProviderCredentials, accessToken: string) => credentials.accessToken === accessToken;
	const facts = ({ accessToken: _token, ...payment }: StoredPayment): ProviderPayment => payment;

	function update(paymentId: string, change: (payment: StoredPayment) => Partial<StoredPayment>): ProviderPayment {
		const payment = payments.get(paymentId);
		if (!payment) throw new ProviderError('Payment not found', 404);
		const updated = { ...payment, ...change(payment), updatedAt: now() };
		payments.set(paymentId, updated);
		return facts(updated);
	}

	return {
		name: 'mercadopago',
		preferences,
		payments,

		async createPreference(credentials, request) {
			const id = `sim-pref-${sha256Hex(request.idempotencyKey).slice(0, 16)}`;
			if (!preferences.has(id)) preferences.set(id, { id, accessToken: credentials.accessToken, request, createdAt: now() });
			const url = new URL('/pago-simulado', request.backUrls.success);
			url.searchParams.set('pref', id);
			return { id, redirectUrl: url.toString() };
		},

		async getPayment(credentials, paymentId) {
			const payment = payments.get(paymentId);
			// Another tenant's token cannot read this payment, like the real API.
			if (!payment || !owned(credentials, payment.accessToken)) throw new ProviderError('Payment not found', 404);
			return facts(payment);
		},

		async searchPayments(credentials, search) {
			const matching = [...payments.values()]
				.filter((payment) => owned(credentials, payment.accessToken))
				.filter((payment) => payment.updatedAt && payment.updatedAt >= search.updatedFrom && payment.updatedAt <= search.updatedTo)
				.sort((a, b) => a.updatedAt!.getTime() - b.updatedAt!.getTime());
			return { results: matching.slice(search.offset, search.offset + search.limit).map(facts), total: matching.length };
		},

		async verifyAccount(credentials) {
			if (!credentials.accessToken.startsWith('TEST-')) throw new ProviderError('Simulator only accepts TEST- tokens', 401);
			return { collectorId: simulatorCollectorId(credentials.accessToken), nickname: 'SIMULADOR' };
		},

		pay(preferenceId, outcome) {
			const preference = preferences.get(preferenceId);
			if (!preference) throw new ProviderError('Preference not found', 404);
			const items = preference.request.items;
			const amountMinor = items.reduce((sum, item) => sum + item.unitPriceMinor * item.quantity, 0);
			const approved = outcome === 'approved';
			const feeMinor = approved ? Math.round((amountMinor * SIMULATED_FEE_BASIS_POINTS) / 10_000) : null;
			const at = now();
			const payment: StoredPayment = {
				id: String(sequence++),
				status: outcome,
				statusDetail: approved ? 'accredited' : outcome === 'rejected' ? 'cc_rejected_other_reason' : 'pending_contingency',
				externalReference: preference.request.orderReference,
				amountMinor,
				currency: items[0]?.currency ?? 'ARS',
				collectorId: simulatorCollectorId(preference.accessToken),
				approvedAt: approved ? at : null,
				refundedMinor: 0,
				feeMinor,
				netMinor: feeMinor === null ? null : amountMinor - feeMinor,
				// Account-money style: released as soon as it is approved.
				releaseDate: approved ? at : null,
				releaseStatus: approved ? 'released' : null,
				updatedAt: at,
				accessToken: preference.accessToken
			};
			payments.set(payment.id, payment);
			return facts(payment);
		},

		setStatus(paymentId, status) {
			return update(paymentId, (payment) => ({
				status,
				statusDetail: status,
				refundedMinor: status === 'refunded' ? payment.amountMinor : payment.refundedMinor
			}));
		},

		refundPartially(paymentId, amountMinor) {
			return update(paymentId, (payment) => {
				if (payment.status !== 'approved' || amountMinor <= 0 || payment.refundedMinor + amountMinor >= payment.amountMinor) {
					throw new ProviderError('Invalid partial refund', 400);
				}
				return { refundedMinor: payment.refundedMinor + amountMinor, statusDetail: 'partially_refunded' };
			});
		},

		tamper(paymentId, changes) {
			return update(paymentId, () => changes);
		}
	};
}
