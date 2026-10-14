/**
 * Payment provider port. The domain never talks to Mercado Pago directly; it
 * receives verified facts from here. Credentials are passed per call because
 * every organization has its own account (FR-ORG-03, FR-PAY-01).
 */
export interface ProviderCredentials {
	readonly accessToken: string;
	readonly webhookSecret: string;
}

export interface PreferenceRequest {
	readonly orderReference: string;
	readonly idempotencyKey: string;
	readonly items: readonly { id: string; title: string; quantity: number; unitPriceMinor: number; currency: string }[];
	readonly payer: { email: string; firstName: string; lastName: string; documentType: string; documentNumber: string };
	readonly notificationUrl: string;
	readonly backUrls: { success: string; failure: string; pending: string };
	readonly expiresAt: Date;
	readonly statementDescriptor: string;
}

export interface Preference {
	readonly id: string;
	readonly redirectUrl: string;
}

export interface ProviderPayment {
	readonly id: string;
	readonly status: string;
	readonly statusDetail: string | null;
	readonly externalReference: string | null;
	readonly amountMinor: number;
	readonly currency: string;
	readonly collectorId: string | null;
	readonly approvedAt: Date | null;
}

export interface ProviderAccount {
	readonly collectorId: string;
	readonly nickname: string | null;
}

export interface PaymentProvider {
	readonly name: 'mercadopago';
	createPreference(credentials: ProviderCredentials, request: PreferenceRequest): Promise<Preference>;
	getPayment(credentials: ProviderCredentials, paymentId: string): Promise<ProviderPayment>;
	verifyAccount(credentials: ProviderCredentials): Promise<ProviderAccount>;
}

export class ProviderError extends Error {
	constructor(
		message: string,
		readonly status: number | null
	) {
		super(message);
	}
}
