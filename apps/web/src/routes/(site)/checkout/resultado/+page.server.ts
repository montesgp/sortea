import { api } from '#lib/server/api.js';
import { readReceipt } from '#lib/server/receipt.js';
import type { PageServerLoad } from './$types';

interface OrderStatus {
	reference: string;
	status: string;
	totalMinor: number;
	currency: string;
	email: string;
	items: { name: string; quantity: number; kind: string; lineTotalMinor: number }[];
	entries: number[];
	/** Coupon digits of the order's campaign (ADR 0014 §1). */
	entryDigits: number;
}

/**
 * Return page after Mercado Pago. The query string is never trusted: the
 * status shown is the one the API holds, confirmed only by a verified
 * webhook (AC-03).
 */
export const load: PageServerLoad = async (event) => {
	const receipt = readReceipt(event.cookies);
	const reference = event.url.searchParams.get('ref');
	if (!receipt || (reference && reference !== receipt.reference)) return { order: null, accessCode: null };
	const result = await api<OrderStatus>(event, '/checkout/orders/status', { method: 'POST', body: receipt });
	return { order: result.ok ? result.data : null, accessCode: receipt.accessCode };
};
