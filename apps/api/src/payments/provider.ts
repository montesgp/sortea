/**
 * Payment provider port. The domain never talks to Mercado Pago directly; it
 * receives verified facts from here. Credentials are passed per call because
 * every organization has its own account (FR-ORG-03, FR-PAY-01).
 *
 * Checkout Pro runs through the Orders API (ADR 0018): one Mercado Pago order
 * per checkout. Its id (`ORD...`) is the provider payment id the platform
 * stores, so a checkout has one payment row however many attempts the buyer makes.
 */
export interface ProviderCredentials {
	readonly accessToken: string;
	readonly webhookSecret: string;
}

export interface ProviderCheckoutRequest {
	readonly orderReference: string;
	readonly idempotencyKey: string;
	readonly items: readonly { id: string; title: string; quantity: number; unitPriceMinor: number; currency: string }[];
	readonly payer: { email: string; firstName: string; lastName: string; documentType: string; documentNumber: string };
	/** The account is a sandbox (test) account; Mercado Pago refuses real buyers there. */
	readonly sandbox: boolean;
	readonly returnUrls: { success: string; failure: string; pending: string };
	readonly expiresAt: Date;
	readonly statementDescriptor: string;
}

export interface Checkout {
	/** The Mercado Pago order id. */
	readonly id: string;
	readonly redirectUrl: string;
}

/** What the provider reports for one checkout (a Mercado Pago order and its transactions). */
export interface ProviderPayment {
	readonly id: string;
	/** The provider's status word; `mapMercadoPagoStatus` turns it into the internal one. */
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
	/** Payment transactions in the order; 0 while the buyer has not tried to pay. */
	readonly attempts: number;
}

export interface OrderSearch {
	/** Inclusive range over the order's creation time, the only date the Orders search filters by. */
	readonly createdFrom: Date;
	readonly createdTo: Date;
	readonly offset: number;
	readonly limit: number;
}

export interface OrderSearchPage {
	readonly results: readonly ProviderPayment[];
	/** Orders matching the search. When the provider does not state it, a full page counts one more, so the caller asks for the next page. */
	readonly total: number;
}

/**
 * Mercado Pago order ids are `ORD` plus letters and digits (`ORDTST...` for test orders,
 * `ORDSIM...` for the local simulator). Payments stored before the Orders API (ADR 0018)
 * hold numeric Payments API ids, which are not order ids.
 */
export const ORDER_ID = /^ORD[0-9A-Za-z]{1,60}$/;

export function isOrderId(id: string): boolean {
	return ORDER_ID.test(id);
}

/** The Orders search returns at most this many orders per page. */
export const ORDER_SEARCH_PAGE_SIZE = 50;

export interface ProviderAccount {
	readonly collectorId: string;
	readonly nickname: string | null;
	/** Mercado Pago reports a test user (`test_user` tag): its money is fictitious. The simulator's accounts are too. */
	readonly testUser: boolean;
	/** The account belongs to the local simulator. */
	readonly simulator?: true;
}

export interface PaymentProvider {
	readonly name: 'mercadopago';
	createCheckout(credentials: ProviderCredentials, request: ProviderCheckoutRequest): Promise<Checkout>;
	/** Reads one order of the credentials' own account; another account's order is a 404. */
	getOrder(credentials: ProviderCredentials, orderId: string): Promise<ProviderPayment>;
	/** Orders of the credentials' own account created in a time range (reconciliation). */
	searchOrders(credentials: ProviderCredentials, search: OrderSearch): Promise<OrderSearchPage>;
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
