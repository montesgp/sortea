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
	/** Money returned to the buyer so far; equals the amount after a full refund. */
	readonly refundedMinor: number;
	/** Fees charged to the merchant and the net it receives, when the provider reports them (FR-PAY-06). */
	readonly feeMinor: number | null;
	readonly netMinor: number | null;
	/** When the money becomes available to the merchant, and whether it already was. */
	readonly releaseDate: Date | null;
	readonly releaseStatus: string | null;
	readonly updatedAt: Date | null;
}

export interface PaymentSearch {
	/** Inclusive range over the provider's last-update time. */
	readonly updatedFrom: Date;
	readonly updatedTo: Date;
	readonly offset: number;
	readonly limit: number;
}

export interface PaymentSearchPage {
	/** Sorted by last update, oldest first. */
	readonly results: readonly ProviderPayment[];
	readonly total: number;
}

export interface ProviderAccount {
	readonly collectorId: string;
	readonly nickname: string | null;
}

export interface PaymentProvider {
	readonly name: 'mercadopago';
	createPreference(credentials: ProviderCredentials, request: PreferenceRequest): Promise<Preference>;
	getPayment(credentials: ProviderCredentials, paymentId: string): Promise<ProviderPayment>;
	/** Payments of the credentials' own account updated in a time range (reconciliation). */
	searchPayments(credentials: ProviderCredentials, search: PaymentSearch): Promise<PaymentSearchPage>;
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
