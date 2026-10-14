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

export interface PaymentSimulator extends PaymentProvider {
	readonly preferences: Map<string, SimulatedPreference>;
	readonly payments: Map<string, ProviderPayment & { accessToken: string }>;
	pay(preferenceId: string, outcome: 'approved' | 'rejected' | 'in_process'): ProviderPayment;
	setStatus(paymentId: string, status: 'refunded' | 'charged_back' | 'approved'): ProviderPayment;
}

/** Deterministic merchant id for a simulated account; the seed uses the same formula. */
export function simulatorCollectorId(accessToken: string): string {
	return `sim-${sha256Hex(accessToken).slice(0, 10)}`;
}

export function createPaymentSimulator(options: { webOrigin: string; now?: () => Date }): PaymentSimulator {
	const now = options.now ?? (() => new Date());
	const preferences = new Map<string, SimulatedPreference>();
	const payments = new Map<string, ProviderPayment & { accessToken: string }>();
	let sequence = 9_000_000_000;

	const owned = (credentials: ProviderCredentials, accessToken: string) => credentials.accessToken === accessToken;

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
			const { accessToken: _token, ...facts } = payment;
			return facts;
		},

		async verifyAccount(credentials) {
			if (!credentials.accessToken.startsWith('TEST-')) throw new ProviderError('Simulator only accepts TEST- tokens', 401);
			return { collectorId: simulatorCollectorId(credentials.accessToken), nickname: 'SIMULADOR' };
		},

		pay(preferenceId, outcome) {
			const preference = preferences.get(preferenceId);
			if (!preference) throw new ProviderError('Preference not found', 404);
			const items = preference.request.items;
			const payment = {
				id: String(sequence++),
				status: outcome,
				statusDetail: outcome === 'approved' ? 'accredited' : outcome === 'rejected' ? 'cc_rejected_other_reason' : 'pending_contingency',
				externalReference: preference.request.orderReference,
				amountMinor: items.reduce((sum, item) => sum + item.unitPriceMinor * item.quantity, 0),
				currency: items[0]?.currency ?? 'ARS',
				collectorId: simulatorCollectorId(preference.accessToken),
				approvedAt: outcome === 'approved' ? now() : null,
				accessToken: preference.accessToken
			};
			payments.set(payment.id, payment);
			const { accessToken: _token, ...facts } = payment;
			return facts;
		},

		setStatus(paymentId, status) {
			const payment = payments.get(paymentId);
			if (!payment) throw new ProviderError('Payment not found', 404);
			const updated = { ...payment, status, statusDetail: status };
			payments.set(paymentId, updated);
			const { accessToken: _token, ...facts } = updated;
			return facts;
		}
	};
}
