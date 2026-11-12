import { api } from '#lib/server/api.js';
import { readReceipt } from '#lib/server/receipt.js';
import type { PageServerLoad } from './$types';

interface OrderStatus {
	reference: string;
	status: string;
	totalMinor: number;
	currency: string;
	email: string;
	createdAt: string;
	items: { name: string; quantity: number; kind: string; lineTotalMinor: number }[];
	entries: number[];
	/** Coupon digits of the order's campaign (ADR 0014 §1). */
	entryDigits: number;
	/** The chances the purchase gives: reserved while it waits, allocated once paid (S7). */
	chances: { count: number; campaign: string } | null;
}

/**
 * Return page after Mercado Pago. The query string is never trusted: the
 * status shown is the one the API holds, confirmed only by a verified
 * webhook (AC-03).
 */
export const load: PageServerLoad = async (event) => {
	const unknown = { order: null, accessCode: null, reference: null, unavailable: false };
	const receipt = readReceipt(event.cookies);
	const reference = event.url.searchParams.get('ref');
	if (!receipt || (reference && reference !== receipt.reference)) return unknown;
	const result = await api<OrderStatus>(event, '/checkout/orders/status', { method: 'POST', body: receipt });
	if (result.ok) return { order: result.data, accessCode: receipt.accessCode, reference: receipt.reference, unavailable: false };
	// The browser holds this order: a status the API cannot give now (rate limit, outage) is not
	// "no order" (S7, owner feedback 2026-11-11b). Only an order the API does not know is not found.
	if (result.status === 404) return unknown;
	return { order: null, accessCode: receipt.accessCode, reference: receipt.reference, unavailable: true };
};
