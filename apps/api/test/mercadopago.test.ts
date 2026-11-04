import { mapMercadoPagoStatus } from '@sortea/domain';
import { describe, expect, it } from 'vitest';
import { createMercadoPagoProvider } from '../src/payments/mercadopago';
import { ProviderError, type ProviderCheckoutRequest } from '../src/payments/provider';

// Payloads are shaped like the examples of the official reference
// (developers/es/reference/online-payments/checkout-pro: create, get and search order).

const credentials = { accessToken: 'APP_USR-test', webhookSecret: 'secret' };
const now = new Date('2026-11-04T12:00:00Z');

interface Seen {
	url: string;
	method: string;
	headers: Record<string, string>;
	body: unknown;
}

function fakeFetch(body: unknown, seen: Seen[] = [], status = 200): typeof fetch {
	return (async (input: string | URL | Request, init: RequestInit = {}) => {
		seen.push({
			url: String(input),
			method: init.method ?? 'GET',
			headers: Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([key, value]) => [key.toLowerCase(), value])),
			body: init.body ? JSON.parse(String(init.body)) : null
		});
		return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
	}) as typeof fetch;
}

const checkout: ProviderCheckoutRequest = {
	orderReference: 'MG-7K2Q9XHD',
	idempotencyKey: '5b1f8a3e-3a51-4c43-9d6c-0b0e6f1d2a11',
	items: [
		{ id: 'variant-1', title: 'Manual', quantity: 2, unitPriceMinor: 1_200_000, currency: 'ARS' },
		{ id: 'delivery', title: 'Envío', quantity: 1, unitPriceMinor: 350_005, currency: 'ARS' }
	],
	payer: { email: 'juana@example.com', firstName: 'Juana', lastName: 'Pérez', documentType: 'DNI', documentNumber: '30123456' },
	sandbox: false,
	returnUrls: { success: 'https://moto.test/checkout/resultado?ref=MG-7K2Q9XHD', failure: 'https://moto.test/f', pending: 'https://moto.test/p' },
	expiresAt: new Date(now.getTime() + 60 * 60_000),
	statementDescriptor: 'MotoGarage tienda oficial de motos'
};

const created = {
	id: 'ORD01JQ4S4KY8HWQ6NA5PXB65B3D3',
	type: 'online',
	processing_mode: 'manual',
	status: 'created',
	status_detail: 'created',
	external_reference: 'MG-7K2Q9XHD',
	total_amount: '27500.05',
	checkout_url: 'https://www.mercadopago.com.ar/checkout/v1/redirect?order_id=ORD01JQ4S4KY8HWQ6NA5PXB65B3D3&pref_id=1-abc',
	user_id: '12345',
	currency: 'ARS',
	created_date: '2026-11-04T12:00:00.045317772Z',
	last_updated_date: '2026-11-04T12:00:00.045317772Z'
};

const processed = {
	...created,
	status: 'processed',
	status_detail: 'accredited',
	total_paid_amount: '27500.05',
	last_updated_date: '2026-11-04T12:10:00.000Z',
	transactions: {
		payments: [
			{ id: 'PAY01J67CQQH5904WDBVZEM4JMEP3', amount: '27500.05', paid_amount: '27500.05', status: 'processed', status_detail: 'accredited', reference: { id: '183961436800' } }
		]
	}
};

describe('Mercado Pago Orders adapter: checkout', () => {
	it('creates a Checkout Pro order with decimal strings, a duration, return URLs and an idempotency key', async () => {
		const seen: Seen[] = [];
		const provider = createMercadoPagoProvider(fakeFetch(created, seen), () => now);
		const result = await provider.createCheckout(credentials, checkout);

		expect(result).toEqual({ id: created.id, redirectUrl: created.checkout_url });
		expect(seen).toHaveLength(1);
		const [request] = seen;
		expect(request!.method).toBe('POST');
		expect(request!.url).toBe('https://api.mercadopago.com/v1/orders');
		expect(request!.headers['x-idempotency-key']).toBe(checkout.idempotencyKey);
		expect(request!.headers.authorization).toBe('Bearer APP_USR-test');
		expect(request!.body).toEqual({
			type: 'online',
			processing_mode: 'manual',
			total_amount: '27500.05',
			external_reference: 'MG-7K2Q9XHD',
			expiration_time: 'PT1H',
			payer: { email: 'juana@example.com', first_name: 'Juana', last_name: 'Pérez', identification: { type: 'DNI', number: '30123456' } },
			items: [
				{ external_code: 'variant-1', title: 'Manual', quantity: 2, unit_price: '12000.00' },
				{ external_code: 'delivery', title: 'Envío', quantity: 1, unit_price: '3500.05' }
			],
			config: {
				statement_descriptor: 'MotoGarage tienda ofic',
				online: {
					success_url: checkout.returnUrls.success,
					failure_url: checkout.returnUrls.failure,
					pending_url: checkout.returnUrls.pending,
					auto_return: 'approved'
				}
			}
		});
	});

	it('in sandbox mode sends no payer, so a test buyer can pay a test seller (spike L4)', async () => {
		const seen: Seen[] = [];
		const provider = createMercadoPagoProvider(fakeFetch(created, seen), () => now);
		await provider.createCheckout(credentials, { ...checkout, sandbox: true });
		const body = seen[0]!.body as Record<string, unknown>;
		expect(body).not.toHaveProperty('payer');
		expect(JSON.stringify(body)).not.toContain('juana@example.com');
		expect(JSON.stringify(body)).not.toContain('30123456');
	});

	it('expresses the time left until the order expires as an ISO 8601 duration, never longer', async () => {
		const seen: Seen[] = [];
		const provider = createMercadoPagoProvider(fakeFetch(created, seen), () => now);
		const at = (ms: number) => new Date(now.getTime() + ms);
		for (const expiresAt of [at(59 * 60_000 + 30_500), at(2 * 3_600_000 + 5_000), at(45_000)]) {
			await provider.createCheckout(credentials, { ...checkout, expiresAt });
		}
		expect(seen.map((request) => (request.body as { expiration_time: string }).expiration_time)).toEqual(['PT59M30S', 'PT2H5S', 'PT1M']);
	});

	it('keeps only the HTTP status of a refused creation', async () => {
		const provider = createMercadoPagoProvider(fakeFetch({ message: 'payer juana@example.com invalid' }, [], 400), () => now);
		const error = await provider.createCheckout(credentials, checkout).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(ProviderError);
		expect((error as ProviderError).status).toBe(400);
		expect((error as Error).message).not.toContain('juana');
	});
});

describe('Mercado Pago Orders adapter: order reads', () => {
	it('maps a processed order to an approved payment in minor units, with the seller as merchant', async () => {
		const seen: Seen[] = [];
		const provider = createMercadoPagoProvider(fakeFetch(processed, seen));
		const result = await provider.getOrder(credentials, processed.id);
		expect(seen[0]!.url).toBe(`https://api.mercadopago.com/v1/orders/${processed.id}`);
		expect(result).toEqual({
			id: processed.id,
			status: 'processed',
			statusDetail: 'accredited',
			externalReference: 'MG-7K2Q9XHD',
			amountMinor: 2_750_005,
			currency: 'ARS',
			collectorId: '12345',
			approvedAt: new Date('2026-11-04T12:10:00.000Z'),
			refundedMinor: 0,
			// The Orders API reports no fees, net or release; settlement reports do.
			feeMinor: null,
			netMinor: null,
			releaseDate: null,
			releaseStatus: null,
			updatedAt: new Date('2026-11-04T12:10:00.000Z'),
			attempts: 1
		});
	});

	it('maps every order status of the docs, refunds and chargebacks included', async () => {
		const refund = { id: 'REF01KRH48XPG7HJSJ565BDTVPH2F', transaction_id: 'PAY01J67CQQH5904WDBVZEM4JMEP3', amount: '1000.00', status: 'processed' };
		const cases = [
			{ order: created, status: 'pending', approved: false, refundedMinor: 0, attempts: 0 },
			{ order: { ...processed, status: 'processing', status_detail: 'in_process' }, status: 'in_process', approved: false, refundedMinor: 0, attempts: 1 },
			{ order: { ...processed, status: 'action_required', status_detail: 'waiting_capture' }, status: 'pending', approved: false, refundedMinor: 0, attempts: 1 },
			{ order: { ...processed, status: 'failed', status_detail: 'rejected_by_issuer' }, status: 'rejected', approved: false, refundedMinor: 0, attempts: 1 },
			{ order: { ...created, status: 'canceled', status_detail: 'canceled' }, status: 'cancelled', approved: false, refundedMinor: 0, attempts: 0 },
			{ order: { ...created, status: 'expired', status_detail: 'expired' }, status: 'cancelled', approved: false, refundedMinor: 0, attempts: 0 },
			{
				order: { ...processed, status_detail: 'partially_refunded', transactions: { ...processed.transactions, refunds: [refund, { ...refund, id: 'REF2', amount: '5.00', status: 'failed' }] } },
				status: 'approved',
				approved: true,
				refundedMinor: 100_000,
				attempts: 1
			},
			{ order: { ...processed, status: 'refunded', status_detail: 'refunded', transactions: { ...processed.transactions, refunds: [{ ...refund, amount: '27500.05' }] } }, status: 'refunded', approved: false, refundedMinor: 2_750_005, attempts: 1 },
			// A full refund without its movement listed still returns the whole order.
			{ order: { ...processed, status: 'refunded', status_detail: 'refunded' }, status: 'refunded', approved: false, refundedMinor: 2_750_005, attempts: 1 },
			{
				order: {
					...processed,
					status: 'charged_back',
					status_detail: 'settled',
					transactions: { ...processed.transactions, chargebacks: [{ id: 'CBK12JRTXT3GC8CJGW394QZZ349M7', transaction_id: 'PAY01J67CQQH5904WDBVZEM4JMEP3', case_id: '123456789', status: 'settled' }] }
				},
				status: 'charged_back',
				approved: false,
				refundedMinor: 0,
				attempts: 1
			}
		];
		for (const { order, status, approved, refundedMinor, attempts } of cases) {
			const result = await createMercadoPagoProvider(fakeFetch(order)).getOrder(credentials, order.id);
			expect([order.status, mapMercadoPagoStatus(result.status), result.approvedAt !== null, result.refundedMinor, result.attempts]).toEqual([
				order.status,
				status,
				approved,
				refundedMinor,
				attempts
			]);
			expect(result.amountMinor).toBe(2_750_005);
		}
	});

	it('answers 404 without calling Mercado Pago for an id that is not an order id', async () => {
		const seen: Seen[] = [];
		const provider = createMercadoPagoProvider(fakeFetch(processed, seen));
		for (const id of ['1234567890', 'ORD/../users/me', '']) {
			const error = await provider.getOrder(credentials, id).catch((caught: unknown) => caught);
			expect((error as ProviderError).status).toBe(404);
		}
		expect(seen).toEqual([]);
	});

	it('searches the account orders by creation date, 50 per page', async () => {
		const seen: Seen[] = [];
		const provider = createMercadoPagoProvider(fakeFetch({ data: [processed], paging: { total: '54', total_pages: '2', offset: '0', limit: '50' } }, seen));
		const page = await provider.searchOrders(credentials, {
			createdFrom: new Date('2026-10-20T00:00:00Z'),
			createdTo: new Date('2026-10-21T00:00:00Z'),
			offset: 50,
			limit: 50
		});
		expect(page.total).toBe(54);
		expect(page.results.map((order) => [order.id, order.status, order.amountMinor])).toEqual([[processed.id, 'processed', 2_750_005]]);
		const url = new URL(seen[0]!.url);
		expect(url.pathname).toBe('/v1/orders');
		expect(Object.fromEntries(url.searchParams)).toEqual({
			begin_date: '2026-10-20T00:00:00.000Z',
			end_date: '2026-10-21T00:00:00.000Z',
			offset: '50',
			limit: '50'
		});
	});

	it('verifies the account with /users/me, as before', async () => {
		const seen: Seen[] = [];
		const provider = createMercadoPagoProvider(fakeFetch({ id: 12345, nickname: 'MOTOGARAGE' }, seen));
		expect(await provider.verifyAccount(credentials)).toEqual({ collectorId: '12345', nickname: 'MOTOGARAGE' });
		expect(seen[0]!.url).toBe('https://api.mercadopago.com/users/me');
	});
});
