import { mapMercadoPagoStatus, minorToDecimalString, parseDecimalMinor } from '@sortea/domain';
import type { PaymentProvider, ProviderCredentials, ProviderPayment } from './provider';
import { isOrderId, ProviderError } from './provider';

const baseUrl = 'https://api.mercadopago.com';

/** The fields of a Mercado Pago order (Orders API) the platform reads. */
interface MercadoPagoOrder {
	id: string;
	status: string;
	status_detail?: string | null;
	external_reference?: string | null;
	total_amount: string;
	currency?: string | null;
	user_id?: string | number | null;
	last_updated_date?: string | null;
	transactions?: {
		payments?: { id: string; status?: string | null; reference_id?: string | null; reference?: { id?: string | null } | null }[];
		refunds?: { id: string; amount?: string | null; status?: string | null }[];
		chargebacks?: { id: string; status?: string | null }[];
	} | null;
}

/** The fields of a payment (`GET /v1/payments/{id}`) that state the money: the Orders API omits them. */
interface MercadoPagoPaymentMoney {
	fee_details?: { type?: string | null; amount?: number | string | null; fee_payer?: string | null }[] | null;
	transaction_details?: { net_received_amount?: number | string | null } | null;
	money_release_date?: string | null;
	money_release_status?: string | null;
}

type PaymentMoney = Pick<ProviderPayment, 'feeMinor' | 'netMinor' | 'releaseDate' | 'releaseStatus'>;

const unknownMoney: PaymentMoney = { feeMinor: null, netMinor: null, releaseDate: null, releaseStatus: null };

/** Reports something worth a look without failing the read. Never pass credentials or personal data. */
export type ProviderWarning = (message: string, details: Record<string, unknown>) => void;

const warnOnStderr: ProviderWarning = (message, details) => console.warn(JSON.stringify({ level: 'warn', msg: message, ...details }));

function minor(value: string | null | undefined, field: string): number {
	const parsed = value === null || value === undefined ? null : parseDecimalMinor(value);
	if (parsed === null) throw new ProviderError(`Mercado Pago order has an unreadable ${field}`, 502);
	return parsed;
}

/** A Payments API amount (a JSON number like `61.5`, or a decimal string) in minor units, or null. */
function amountMinor(value: number | string | null | undefined): number | null {
	if (typeof value === 'number') return Number.isFinite(value) ? parseDecimalMinor(value.toFixed(2)) : null;
	return typeof value === 'string' ? parseDecimalMinor(value) : null;
}

/**
 * The money of a payment read from the Payments API:
 * - fee: the sum of `fee_details` the seller pays (`fee_payer: collector`); fees the buyer pays
 *   (financing) are not the seller's cost. A payment that lists none has a fee of zero;
 * - net: `transaction_details.net_received_amount`;
 * - release: `money_release_date` and `money_release_status`.
 * A field that is missing or unreadable stays unknown.
 */
export function paymentMoney(payment: MercadoPagoPaymentMoney): PaymentMoney {
	const fees = Array.isArray(payment.fee_details)
		? payment.fee_details.filter((fee) => fee.fee_payer === 'collector').map((fee) => amountMinor(fee.amount))
		: null;
	const releaseDate = payment.money_release_date ? new Date(payment.money_release_date) : null;
	return {
		feeMinor: fees === null || fees.some((fee) => fee === null) ? null : fees.reduce<number>((sum, fee) => sum + fee!, 0),
		netMinor: amountMinor(payment.transaction_details?.net_received_amount),
		releaseDate: releaseDate && !Number.isNaN(releaseDate.getTime()) ? releaseDate : null,
		releaseStatus: payment.money_release_status ?? null
	};
}

/** Order statuses whose payment took money, so the Payments API can state its fees, net and release. */
const moneyStatuses = new Set(['approved', 'refunded', 'charged_back']);
/** Payment transaction statuses of the attempt that took the money. */
const chargedPayments = new Set(['processed', 'refunded', 'charged_back']);
/** The Payments API id is numeric; anything else is not read. */
const PAYMENT_ID = /^\d{1,20}$/;

/**
 * The Payments API id of the order's payment that took the money, or null when the order took none
 * (created, processing, failed, canceled, expired) and there is nothing to read. The id is the
 * payment transaction's reference (`reference_id`, or `reference.id`).
 */
export function chargedPaymentId(order: MercadoPagoOrder): string | null {
	if (!moneyStatuses.has(mapMercadoPagoStatus(order.status))) return null;
	const charged = (order.transactions?.payments ?? []).filter((payment) => payment.status && chargedPayments.has(payment.status));
	for (const payment of charged.reverse()) {
		const id = payment.reference_id ?? payment.reference?.id ?? null;
		if (id && PAYMENT_ID.test(id)) return id;
	}
	return null;
}

/**
 * One order as the payment the confirmation and reconciliation code use:
 * - status: the order status (see `mapMercadoPagoStatus` for the table); status detail as reported;
 * - amount: `total_amount`, the price the order was created with. It is not `total_paid_amount`,
 *   which includes the financing the buyer pays;
 * - merchant: the order's seller, `user_id`;
 * - approval: the last update of a processed order. The platform keeps the first one it saw;
 * - refunded: the processed refunds of `transactions.refunds[]`, or the whole amount for a
 *   refunded order that lists none;
 * - fees, net and release: the Orders API does not report them. `getOrder` reads them from the
 *   order's payment (`paymentMoney`); otherwise they stay unknown (ADR 0018).
 */
export function orderToPayment(order: MercadoPagoOrder): ProviderPayment {
	const amountMinor = minor(order.total_amount, 'total_amount');
	const refunds = (order.transactions?.refunds ?? []).filter((refund) => refund.status === 'processed');
	const listed = refunds.reduce((sum, refund) => sum + minor(refund.amount, 'refund amount'), 0);
	const updatedAt = order.last_updated_date ? new Date(order.last_updated_date) : null;
	return {
		id: order.id,
		status: order.status,
		statusDetail: order.status_detail ?? null,
		externalReference: order.external_reference ?? null,
		amountMinor,
		// Checkout Pro orders of Argentine accounts are charged in pesos; the response says so.
		currency: order.currency ?? 'ARS',
		collectorId: order.user_id === null || order.user_id === undefined ? null : String(order.user_id),
		approvedAt: mapMercadoPagoStatus(order.status) === 'approved' ? updatedAt : null,
		refundedMinor: order.status === 'refunded' && listed === 0 ? amountMinor : listed,
		...unknownMoney,
		updatedAt,
		attempts: order.transactions?.payments?.length ?? 0
	};
}

/** The time left until `expiresAt` as an ISO 8601 duration ("PT59M30S"), at least a minute and never longer. */
export function expirationDuration(expiresAt: Date, now: Date): string {
	const total = Math.max(60, Math.floor((expiresAt.getTime() - now.getTime()) / 1000));
	const [hours, minutes, seconds] = [Math.floor(total / 3600), Math.floor((total % 3600) / 60), total % 60];
	return `PT${hours ? `${hours}H` : ''}${minutes ? `${minutes}M` : ''}${seconds ? `${seconds}S` : ''}`;
}

/** Mercado Pago Checkout Pro through the Orders API over plain HTTPS; no SDK so every field is explicit. */
export function createMercadoPagoProvider(
	fetchImpl: typeof fetch = fetch,
	now: () => Date = () => new Date(),
	warn: ProviderWarning = warnOnStderr
): PaymentProvider {
	async function call<T>(credentials: ProviderCredentials, path: string, init: RequestInit = {}): Promise<T> {
		const response = await fetchImpl(`${baseUrl}${path}`, {
			...init,
			headers: {
				authorization: `Bearer ${credentials.accessToken}`,
				'content-type': 'application/json',
				...init.headers
			},
			signal: AbortSignal.timeout(10_000)
		});
		if (!response.ok) {
			// The body may echo request data; keep only the status in the error.
			throw new ProviderError(`Mercado Pago ${init.method ?? 'GET'} ${path.split('?')[0]} failed`, response.status);
		}
		return (await response.json()) as T;
	}

	/**
	 * The fees, net and release of the order's payment, read with the same account. One extra request,
	 * only for an order that took money. A failed read (404 included) leaves them unknown and never
	 * fails the order read: the confirmation keeps what it stored before.
	 */
	async function moneyOf(credentials: ProviderCredentials, order: MercadoPagoOrder): Promise<PaymentMoney> {
		const paymentId = chargedPaymentId(order);
		if (!paymentId) return unknownMoney;
		try {
			const payment = await call<MercadoPagoPaymentMoney | null>(credentials, `/v1/payments/${paymentId}`);
			return payment && typeof payment === 'object' ? paymentMoney(payment) : unknownMoney;
		} catch (error) {
			warn('Mercado Pago payment read failed; fees, net and release stay unknown', {
				orderId: order.id,
				paymentId,
				status: error instanceof ProviderError ? error.status : null,
				error: error instanceof ProviderError ? 'provider' : error instanceof Error ? error.name : 'unknown'
			});
			return unknownMoney;
		}
	}

	return {
		name: 'mercadopago',

		async createCheckout(credentials, request) {
			const totalMinor = request.items.reduce((sum, item) => sum + item.unitPriceMinor * item.quantity, 0);
			const body = {
				type: 'online',
				processing_mode: 'manual',
				total_amount: minorToDecimalString(totalMinor),
				external_reference: request.orderReference,
				expiration_time: expirationDuration(request.expiresAt, now()),
				// A test seller refuses real parties, so in sandbox mode the buyer's data stays
				// out and a Mercado Pago test buyer logs in to pay (spike L4).
				...(request.sandbox
					? {}
					: {
							payer: {
								email: request.payer.email,
								first_name: request.payer.firstName,
								last_name: request.payer.lastName,
								identification: { type: request.payer.documentType, number: request.payer.documentNumber }
							}
						}),
				items: request.items.map((item) => ({
					external_code: item.id,
					title: item.title,
					quantity: item.quantity,
					unit_price: minorToDecimalString(item.unitPriceMinor)
				})),
				config: {
					statement_descriptor: request.statementDescriptor.slice(0, 22),
					online: {
						success_url: request.returnUrls.success,
						failure_url: request.returnUrls.failure,
						pending_url: request.returnUrls.pending,
						auto_return: 'approved'
					}
				}
			};
			const created = await call<{ id: string; checkout_url: string }>(credentials, '/v1/orders', {
				method: 'POST',
				body: JSON.stringify(body),
				headers: { 'x-idempotency-key': request.idempotencyKey }
			});
			return { id: created.id, redirectUrl: created.checkout_url };
		},

		async getOrder(credentials, orderId) {
			// Anything else (an old numeric payment id, a crafted path) is no order of this account.
			if (!isOrderId(orderId)) throw new ProviderError('Not a Mercado Pago order id', 404);
			const order = await call<MercadoPagoOrder>(credentials, `/v1/orders/${orderId}`);
			// The order is mapped first, so an unreadable order fails before the payment is read.
			const payment = orderToPayment(order);
			return { ...payment, ...(await moneyOf(credentials, order)) };
		},

		async searchOrders(credentials, search) {
			const query = new URLSearchParams({
				begin_date: search.createdFrom.toISOString(),
				end_date: search.createdTo.toISOString(),
				offset: String(search.offset),
				limit: String(search.limit)
			});
			const page = await call<{ data?: MercadoPagoOrder[]; paging?: { total?: string | number } }>(credentials, `/v1/orders?${query}`);
			// No payment reads here: a search can bring thousands of orders, and the re-reads by id
			// (webhooks, reconciliation) bring the fees (ADR 0018).
			const results = (page.data ?? []).map((order) => orderToPayment(order));
			const reported = page.paging?.total;
			const total = reported === null || reported === undefined || reported === '' ? Number.NaN : Number(reported);
			if (Number.isFinite(total)) return { results, total };
			// Without a total, a full page means there may be more: the caller asks for the next one.
			return { results, total: search.offset + results.length + (results.length >= search.limit ? 1 : 0) };
		},

		async verifyAccount(credentials) {
			const me = await call<{ id: number; nickname?: string; tags?: unknown }>(credentials, '/users/me');
			// Test users carry the `test_user` tag, e.g. ["user_product_seller", "test_user", "normal"].
			const testUser = Array.isArray(me.tags) && me.tags.includes('test_user');
			return { collectorId: String(me.id), nickname: me.nickname ?? null, testUser };
		}
	};
}
