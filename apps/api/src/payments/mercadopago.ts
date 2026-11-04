import { mapMercadoPagoStatus, minorToDecimalString, parseDecimalMinor } from '@sortea/domain';
import type { PaymentProvider, ProviderCredentials, ProviderPayment } from './provider';
import { ProviderError } from './provider';

const baseUrl = 'https://api.mercadopago.com';

/** Mercado Pago order ids are `ORD` plus letters and digits (`ORDTST...` for test orders). */
const ORDER_ID = /^ORD[0-9A-Za-z]{1,60}$/;

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
		payments?: { id: string; status?: string }[];
		refunds?: { id: string; amount?: string | null; status?: string | null }[];
		chargebacks?: { id: string; status?: string | null }[];
	} | null;
}

function minor(value: string | null | undefined, field: string): number {
	const parsed = value === null || value === undefined ? null : parseDecimalMinor(value);
	if (parsed === null) throw new ProviderError(`Mercado Pago order has an unreadable ${field}`, 502);
	return parsed;
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
 * - fees, net and release: the Orders API does not report them, so they stay unknown and
 *   settlement reports state the money (ADR 0006).
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
		feeMinor: null,
		netMinor: null,
		releaseDate: null,
		releaseStatus: null,
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
export function createMercadoPagoProvider(fetchImpl: typeof fetch = fetch, now: () => Date = () => new Date()): PaymentProvider {
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
			if (!ORDER_ID.test(orderId)) throw new ProviderError('Not a Mercado Pago order id', 404);
			return orderToPayment(await call<MercadoPagoOrder>(credentials, `/v1/orders/${orderId}`));
		},

		async searchOrders(credentials, search) {
			const query = new URLSearchParams({
				begin_date: search.createdFrom.toISOString(),
				end_date: search.createdTo.toISOString(),
				offset: String(search.offset),
				limit: String(search.limit)
			});
			const page = await call<{ data?: MercadoPagoOrder[]; paging?: { total?: string | number } }>(credentials, `/v1/orders?${query}`);
			const results = (page.data ?? []).map(orderToPayment);
			const total = Number(page.paging?.total);
			return { results, total: Number.isFinite(total) ? total : results.length };
		},

		async verifyAccount(credentials) {
			const me = await call<{ id: number; nickname?: string }>(credentials, '/users/me');
			return { collectorId: String(me.id), nickname: me.nickname ?? null };
		}
	};
}
