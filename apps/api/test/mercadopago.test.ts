import { describe, expect, it } from 'vitest';
import { createMercadoPagoProvider } from '../src/payments/mercadopago';

const credentials = { accessToken: 'APP_USR-test', webhookSecret: 'secret' };

const payment = {
	id: 1234567890,
	status: 'approved',
	status_detail: 'accredited',
	external_reference: 'MG-7K2Q9XHD',
	transaction_amount: 24000,
	transaction_amount_refunded: 0,
	currency_id: 'ARS',
	collector_id: 42,
	date_approved: '2026-10-20T10:00:00.000-03:00',
	date_last_updated: '2026-10-20T10:00:05.000-03:00',
	money_release_date: '2026-11-03T10:00:00.000-03:00',
	money_release_status: 'pending',
	fee_details: [
		{ type: 'mercadopago_fee', amount: 1509.6, fee_payer: 'collector' },
		{ type: 'financing_fee', amount: 900, fee_payer: 'payer' }
	],
	transaction_details: { net_received_amount: 22490.4 }
};

function fakeFetch(body: unknown, seen: string[] = []): typeof fetch {
	return (async (input: string | URL | Request) => {
		seen.push(String(input));
		return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
	}) as typeof fetch;
}

describe('Mercado Pago adapter', () => {
	it('maps amounts, merchant fees, net and release in minor units', async () => {
		const provider = createMercadoPagoProvider(fakeFetch(payment));
		const result = await provider.getPayment(credentials, '1234567890');
		expect(result).toMatchObject({
			id: '1234567890',
			amountMinor: 2_400_000,
			refundedMinor: 0,
			// The financing fee is paid by the buyer, not the merchant.
			feeMinor: 150_960,
			netMinor: 2_249_040,
			releaseStatus: 'pending',
			collectorId: '42'
		});
		expect(result.releaseDate?.toISOString()).toBe('2026-11-03T13:00:00.000Z');
	});

	it('leaves fees unknown for payments that did not move money', async () => {
		const provider = createMercadoPagoProvider(fakeFetch({ ...payment, status: 'rejected', fee_details: [], transaction_details: { net_received_amount: 0 } }));
		const result = await provider.getPayment(credentials, '1234567890');
		expect(result.feeMinor).toBeNull();
		expect(result.netMinor).toBeNull();
	});

	it('searches the account by last update, oldest first', async () => {
		const seen: string[] = [];
		const provider = createMercadoPagoProvider(fakeFetch({ paging: { total: 1, limit: 100, offset: 0 }, results: [payment] }, seen));
		const page = await provider.searchPayments(credentials, {
			updatedFrom: new Date('2026-10-20T00:00:00Z'),
			updatedTo: new Date('2026-10-21T00:00:00Z'),
			offset: 0,
			limit: 100
		});
		expect(page.total).toBe(1);
		expect(page.results[0]?.id).toBe('1234567890');
		const url = new URL(seen[0]!);
		expect(url.pathname).toBe('/v1/payments/search');
		expect(Object.fromEntries(url.searchParams)).toMatchObject({
			range: 'date_last_updated',
			sort: 'date_last_updated',
			criteria: 'asc',
			begin_date: '2026-10-20T00:00:00.000Z',
			end_date: '2026-10-21T00:00:00.000Z'
		});
	});
});
