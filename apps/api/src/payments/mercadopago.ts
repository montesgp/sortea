import { decimalToMinor, minorToDecimal } from '@sortea/domain';
import type { PaymentProvider, ProviderCredentials, ProviderPayment } from './provider';
import { ProviderError } from './provider';

const baseUrl = 'https://api.mercadopago.com';

/** The fields of a Mercado Pago payment the platform reads. */
interface MercadoPagoPayment {
	id: number;
	status: string;
	status_detail?: string;
	external_reference?: string | null;
	transaction_amount: number;
	transaction_amount_refunded?: number;
	currency_id: string;
	collector_id?: number | null;
	date_approved?: string | null;
	date_last_updated?: string | null;
	money_release_date?: string | null;
	money_release_status?: string | null;
	fee_details?: { type?: string; amount: number; fee_payer?: string }[];
	transaction_details?: { net_received_amount?: number | null };
}

function toPayment(payment: MercadoPagoPayment): ProviderPayment {
	const approved = payment.status === 'approved' || payment.status === 'refunded' || payment.status === 'charged_back';
	// Fees paid by the buyer (e.g. financing) are not the merchant's cost.
	const merchantFees = (payment.fee_details ?? []).filter((fee) => fee.fee_payer !== 'payer');
	const net = payment.transaction_details?.net_received_amount;
	return {
		id: String(payment.id),
		status: payment.status,
		statusDetail: payment.status_detail ?? null,
		externalReference: payment.external_reference ?? null,
		amountMinor: decimalToMinor(payment.transaction_amount),
		currency: payment.currency_id,
		collectorId: payment.collector_id ? String(payment.collector_id) : null,
		approvedAt: payment.date_approved ? new Date(payment.date_approved) : null,
		refundedMinor: decimalToMinor(payment.transaction_amount_refunded ?? 0),
		feeMinor: approved && payment.fee_details ? merchantFees.reduce((sum, fee) => sum + decimalToMinor(fee.amount), 0) : null,
		netMinor: approved && typeof net === 'number' ? decimalToMinor(net) : null,
		releaseDate: payment.money_release_date ? new Date(payment.money_release_date) : null,
		releaseStatus: payment.money_release_status ?? null,
		updatedAt: payment.date_last_updated ? new Date(payment.date_last_updated) : null
	};
}

/** Mercado Pago Checkout Pro over plain HTTPS; no SDK so every field is explicit. */
export function createMercadoPagoProvider(fetchImpl: typeof fetch = fetch): PaymentProvider {
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

		async createPreference(credentials, request) {
			const body = {
				items: request.items.map((item) => ({
					id: item.id,
					title: item.title,
					quantity: item.quantity,
					unit_price: minorToDecimal(item.unitPriceMinor),
					currency_id: item.currency
				})),
				payer: {
					email: request.payer.email,
					name: request.payer.firstName,
					surname: request.payer.lastName,
					identification: { type: request.payer.documentType, number: request.payer.documentNumber }
				},
				external_reference: request.orderReference,
				notification_url: request.notificationUrl,
				back_urls: request.backUrls,
				auto_return: 'approved',
				expires: true,
				expiration_date_to: request.expiresAt.toISOString(),
				statement_descriptor: request.statementDescriptor.slice(0, 22)
			};
			const created = await call<{ id: string; init_point: string; sandbox_init_point?: string }>(
				credentials,
				'/checkout/preferences',
				{ method: 'POST', body: JSON.stringify(body), headers: { 'x-idempotency-key': request.idempotencyKey } }
			);
			const redirectUrl = credentials.accessToken.startsWith('TEST-') ? (created.sandbox_init_point ?? created.init_point) : created.init_point;
			return { id: created.id, redirectUrl };
		},

		async getPayment(credentials, paymentId) {
			if (!/^\d{1,20}$/.test(paymentId)) throw new ProviderError('Invalid payment id', 400);
			return toPayment(await call<MercadoPagoPayment>(credentials, `/v1/payments/${paymentId}`));
		},

		async searchPayments(credentials, search) {
			const query = new URLSearchParams({
				sort: 'date_last_updated',
				criteria: 'asc',
				range: 'date_last_updated',
				begin_date: search.updatedFrom.toISOString(),
				end_date: search.updatedTo.toISOString(),
				offset: String(search.offset),
				limit: String(search.limit)
			});
			const page = await call<{ paging?: { total?: number }; results?: MercadoPagoPayment[] }>(credentials, `/v1/payments/search?${query}`);
			const results = (page.results ?? []).map(toPayment);
			return { results, total: page.paging?.total ?? results.length };
		},

		async verifyAccount(credentials) {
			const me = await call<{ id: number; nickname?: string }>(credentials, '/users/me');
			return { collectorId: String(me.id), nickname: me.nickname ?? null };
		}
	};
}
