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

	it('fits a variant UUID into the 30 characters Mercado Pago allows for an item code', async () => {
		const seen: Seen[] = [];
		const provider = createMercadoPagoProvider(fakeFetch(created, seen), () => now);
		const variantId = '6d7dd2a3-a2df-4317-b721-6987bb033aec';
		await provider.createCheckout(credentials, { ...checkout, items: [{ ...checkout.items[0]!, id: variantId }, checkout.items[1]!] });
		const items = (seen[0]!.body as { items: { external_code: string }[] }).items;
		expect(items.map((item) => item.external_code)).toEqual(['6d7dd2a3a2df4317b7216987bb033a', 'delivery']);
		expect(items.every((item) => item.external_code.length <= 30)).toBe(true);
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
			// This fake answers the order to every path, so the payment read finds no fees.
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

	it('without a paging total, keeps asking while a page comes back full', async () => {
		const order = (index: number) => ({ ...processed, id: `ORD01JQ${String(index).padStart(6, '0')}` });
		const pages = [Array.from({ length: 50 }, (_, index) => order(index)), Array.from({ length: 50 }, (_, index) => order(50 + index)), [order(100), order(101)]];
		const seen: string[] = [];
		const fetchPages = (async (input: string | URL | Request) => {
			const url = new URL(String(input));
			seen.push(url.searchParams.get('offset')!);
			const data = pages[Number(url.searchParams.get('offset')) / 50] ?? [];
			// No `paging.total`, as some responses come.
			return new Response(JSON.stringify({ data, paging: { offset: url.searchParams.get('offset'), limit: '50' } }), { status: 200 });
		}) as typeof fetch;
		const provider = createMercadoPagoProvider(fetchPages);
		const ids: string[] = [];
		// The reconciliation's paging: next offset until it reaches the total or a page is empty.
		for (let offset = 0; ; ) {
			const page = await provider.searchOrders(credentials, { createdFrom: new Date('2026-10-20T00:00:00Z'), createdTo: new Date('2026-10-21T00:00:00Z'), offset, limit: 50 });
			ids.push(...page.results.map((result) => result.id));
			offset += page.results.length;
			if (page.results.length === 0 || offset >= page.total) break;
		}
		expect(seen).toEqual(['0', '50', '100']);
		expect(ids).toHaveLength(102);
		expect(new Set(ids).size).toBe(102);
	});

	it('without a paging total, stops on a short or empty page and asks once more after an exact multiple', async () => {
		const order = (index: number) => ({ ...processed, id: `ORD01JQ${String(index).padStart(6, '0')}` });
		const full = (offset: number) => Array.from({ length: 50 }, (_, index) => order(offset + index));
		const offsets = async (pageAt: (offset: number) => unknown[]) => {
			const seen: number[] = [];
			const provider = createMercadoPagoProvider((async (input: string | URL | Request) => {
				const offset = Number(new URL(String(input)).searchParams.get('offset'));
				seen.push(offset);
				return new Response(JSON.stringify({ data: pageAt(offset), paging: { offset: String(offset), limit: '50' } }), { status: 200 });
			}) as typeof fetch);
			for (let offset = 0; ; ) {
				const page = await provider.searchOrders(credentials, { createdFrom: new Date('2026-10-20T00:00:00Z'), createdTo: new Date('2026-10-21T00:00:00Z'), offset, limit: 50 });
				offset += page.results.length;
				if (page.results.length === 0 || offset >= page.total) break;
			}
			return seen;
		};
		expect(await offsets((offset) => (offset === 0 ? full(0).slice(0, 7) : []))).toEqual([0]);
		expect(await offsets(() => [])).toEqual([0]);
		expect(await offsets((offset) => (offset < 100 ? full(offset) : []))).toEqual([0, 50, 100]);
	});

	it('verifies the account with /users/me, as before', async () => {
		const seen: Seen[] = [];
		const provider = createMercadoPagoProvider(fakeFetch({ id: 12345, nickname: 'MOTOGARAGE' }, seen));
		expect(await provider.verifyAccount(credentials)).toEqual({ collectorId: '12345', nickname: 'MOTOGARAGE', testUser: false });
		expect(seen[0]!.url).toBe('https://api.mercadopago.com/users/me');
	});

	it('reports a test user when /users/me tags the account test_user', async () => {
		const tagged = createMercadoPagoProvider(fakeFetch({ id: 12345, nickname: 'TESTUSER123', tags: ['user_product_seller', 'test_user', 'normal'] }));
		expect(await tagged.verifyAccount(credentials)).toEqual({ collectorId: '12345', nickname: 'TESTUSER123', testUser: true });
		const seller = createMercadoPagoProvider(fakeFetch({ id: 12345, tags: ['normal', 'user_product_seller'] }));
		expect((await seller.verifyAccount(credentials)).testUser).toBe(false);
	});
});

describe('Mercado Pago Orders adapter: fees, net and release from the Payments API', () => {
	/** The payment of a processed order, as `GET /v1/payments/{id}` answers it (official reference fields). */
	const paymentRead = {
		id: 183961436800,
		status: 'approved',
		status_detail: 'accredited',
		external_reference: 'MG-7K2Q9XHD',
		transaction_amount: 27500.05,
		currency_id: 'ARS',
		fee_details: [
			{ type: 'mercadopago_fee', amount: 1729.78, fee_payer: 'collector' },
			{ type: 'financing_fee', amount: 2200, fee_payer: 'payer' }
		],
		transaction_details: { net_received_amount: 25770.27, total_paid_amount: 29700.05, installment_amount: 9900.02 },
		money_release_date: '2026-11-18T12:10:00.000-04:00',
		money_release_status: 'pending'
	};

	type Answer = { status: number; body: unknown } | Error;

	/** Answers by path: the order read, then the payment read. */
	function routedFetch(routes: Record<string, Answer>, seen: Seen[] = []): typeof fetch {
		return (async (input: string | URL | Request, init: RequestInit = {}) => {
			const url = new URL(String(input));
			seen.push({ url: url.toString(), method: init.method ?? 'GET', headers: (init.headers ?? {}) as Record<string, string>, body: null });
			const answer = routes[url.pathname];
			if (!answer) return new Response('{}', { status: 404 });
			if (answer instanceof Error) throw answer;
			return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'content-type': 'application/json' } });
		}) as typeof fetch;
	}

	const ok = (body: unknown): Answer => ({ status: 200, body });
	const orderPath = `/v1/orders/${processed.id}`;
	const paymentPath = '/v1/payments/183961436800';

	it('reads the order payment by its reference id and adds the collector fees, net and release', async () => {
		const seen: Seen[] = [];
		const provider = createMercadoPagoProvider(routedFetch({ [orderPath]: ok(processed), [paymentPath]: ok(paymentRead) }, seen));
		const result = await provider.getOrder(credentials, processed.id);
		expect(seen.map((request) => new URL(request.url).pathname)).toEqual([orderPath, paymentPath]);
		// The same account's credentials read the payment.
		expect(seen[1]!.headers.authorization).toBe('Bearer APP_USR-test');
		expect(result).toMatchObject({
			status: 'processed',
			amountMinor: 2_750_005,
			// Only the fees the seller pays: the buyer's financing is not the seller's cost.
			feeMinor: 172_978,
			netMinor: 2_577_027,
			releaseDate: new Date('2026-11-18T16:10:00.000Z'),
			releaseStatus: 'pending'
		});
	});

	it('accepts the payment reference as `reference_id`, with the spike figures', async () => {
		const order = {
			...processed,
			total_amount: '1500.00',
			transactions: { payments: [{ id: 'PAY01KSPIKE', amount: '1500.00', status: 'processed', reference_id: '187156957767' }] }
		};
		const spike = {
			...paymentRead,
			id: 187156957767,
			transaction_amount: 1500,
			fee_details: [{ type: 'mercadopago_fee', amount: 61.5, fee_payer: 'collector' }],
			transaction_details: { net_received_amount: 1438.5 },
			money_release_date: '2026-11-06T15:00:00.000-04:00',
			money_release_status: 'released'
		};
		const provider = createMercadoPagoProvider(routedFetch({ [orderPath]: ok(order), '/v1/payments/187156957767': ok(spike) }));
		expect(await provider.getOrder(credentials, processed.id)).toMatchObject({
			feeMinor: 6_150,
			netMinor: 143_850,
			releaseDate: new Date('2026-11-06T19:00:00.000Z'),
			releaseStatus: 'released'
		});
	});

	it('reads the payment that took the money when the order lists a rejected attempt first', async () => {
		const seen: Seen[] = [];
		const order = {
			...processed,
			transactions: {
				payments: [{ id: 'PAY01KFAILED', status: 'failed', status_detail: 'rejected_by_issuer', reference: { id: '183961436799' } }, ...processed.transactions.payments]
			}
		};
		const provider = createMercadoPagoProvider(routedFetch({ [orderPath]: ok(order), [paymentPath]: ok(paymentRead) }, seen));
		const result = await provider.getOrder(credentials, processed.id);
		expect(seen.map((request) => new URL(request.url).pathname)).toEqual([orderPath, paymentPath]);
		expect(result).toMatchObject({ feeMinor: 172_978, attempts: 2 });
	});

	it('also reads it for refunded and charged-back orders, whose fees and release still count', async () => {
		for (const status of ['refunded', 'charged_back']) {
			const seen: Seen[] = [];
			const order = { ...processed, status, status_detail: status, transactions: { payments: [{ ...processed.transactions.payments[0]!, status }] } };
			const provider = createMercadoPagoProvider(routedFetch({ [orderPath]: ok(order), [paymentPath]: ok(paymentRead) }, seen));
			const result = await provider.getOrder(credentials, processed.id);
			expect([status, seen.length, result.feeMinor, result.netMinor]).toEqual([status, 2, 172_978, 2_577_027]);
		}
	});

	it('a payment that reports no fee paid by the seller has a fee of zero, not an unknown one', async () => {
		const free = { ...paymentRead, fee_details: [{ type: 'financing_fee', amount: 2200, fee_payer: 'payer' }], transaction_details: { net_received_amount: 27500.05 } };
		const provider = createMercadoPagoProvider(routedFetch({ [orderPath]: ok(processed), [paymentPath]: ok(free) }));
		expect(await provider.getOrder(credentials, processed.id)).toMatchObject({ feeMinor: 0, netMinor: 2_750_005 });
	});

	it('makes no extra request for orders that took no money', async () => {
		const attempt = (status: string) => ({ transactions: { payments: [{ ...processed.transactions.payments[0]!, status }] } });
		const unpaid = [
			created,
			{ ...processed, status: 'processing', status_detail: 'in_process', ...attempt('processing') },
			{ ...processed, status: 'action_required', status_detail: 'waiting_payment', ...attempt('action_required') },
			{ ...processed, status: 'failed', status_detail: 'rejected_by_issuer', ...attempt('failed') },
			{ ...created, status: 'canceled', status_detail: 'canceled' },
			{ ...created, status: 'expired', status_detail: 'expired' }
		];
		for (const order of unpaid) {
			const seen: Seen[] = [];
			const provider = createMercadoPagoProvider(routedFetch({ [orderPath]: ok(order), [paymentPath]: ok(paymentRead) }, seen));
			const result = await provider.getOrder(credentials, processed.id);
			expect([order.status, seen.length, result.feeMinor, result.netMinor, result.releaseDate, result.releaseStatus]).toEqual([order.status, 1, null, null, null, null]);
		}
	});

	it('makes no extra request when the payment has no numeric reference id', async () => {
		const seen: Seen[] = [];
		const order = { ...processed, transactions: { payments: [{ id: 'PAY01KNOREF', status: 'processed' }, { id: 'PAY01KODD', status: 'processed', reference_id: '../users/me' }] } };
		const provider = createMercadoPagoProvider(routedFetch({ [orderPath]: ok(order) }, seen));
		expect(await provider.getOrder(credentials, processed.id)).toMatchObject({ status: 'processed', feeMinor: null });
		expect(seen).toHaveLength(1);
	});

	it('when the payment read fails, the order read still succeeds without fees and the failure is logged without credentials', async () => {
		const failures: Answer[] = [{ status: 404, body: { message: 'Payment not found' } }, { status: 500, body: { message: 'internal' } }, new TypeError('fetch failed')];
		for (const failure of failures) {
			const warnings: { message: string; details: Record<string, unknown> }[] = [];
			const provider = createMercadoPagoProvider(routedFetch({ [orderPath]: ok(processed), [paymentPath]: failure }), () => now, (message, details) => warnings.push({ message, details }));
			const result = await provider.getOrder(credentials, processed.id);
			expect(result).toMatchObject({
				status: 'processed',
				amountMinor: 2_750_005,
				approvedAt: new Date('2026-11-04T12:10:00.000Z'),
				feeMinor: null,
				netMinor: null,
				releaseDate: null,
				releaseStatus: null
			});
			expect(warnings).toHaveLength(1);
			expect(warnings[0]!.details).toMatchObject({ orderId: processed.id, paymentId: '183961436800' });
			expect(JSON.stringify(warnings)).not.toContain('APP_USR-test');
		}
	});

	it('a payment answer without readable fields leaves them unknown', async () => {
		const provider = createMercadoPagoProvider(
			routedFetch({ [orderPath]: ok(processed), [paymentPath]: ok({ id: 183961436800, fee_details: [{ amount: 'x', fee_payer: 'collector' }], money_release_date: 'soon' }) }),
			() => now,
			() => {}
		);
		expect(await provider.getOrder(credentials, processed.id)).toMatchObject({ status: 'processed', feeMinor: null, netMinor: null, releaseDate: null, releaseStatus: null });
	});

	it('a failing order read still fails, and the payment is not read', async () => {
		const seen: Seen[] = [];
		const provider = createMercadoPagoProvider(routedFetch({ [orderPath]: { status: 500, body: {} }, [paymentPath]: ok(paymentRead) }, seen));
		const error = await provider.getOrder(credentials, processed.id).catch((caught: unknown) => caught);
		expect((error as ProviderError).status).toBe(500);
		expect(seen).toHaveLength(1);
	});

	it('the orders search makes no payment reads: re-reads by id bring the fees', async () => {
		const seen: Seen[] = [];
		const provider = createMercadoPagoProvider(routedFetch({ '/v1/orders': ok({ data: [processed], paging: { total: '1' } }), [paymentPath]: ok(paymentRead) }, seen));
		const page = await provider.searchOrders(credentials, { createdFrom: new Date('2026-10-20T00:00:00Z'), createdTo: new Date('2026-10-21T00:00:00Z'), offset: 0, limit: 50 });
		expect(seen).toHaveLength(1);
		expect(page.results.map((order) => order.feeMinor)).toEqual([null]);
	});
});
