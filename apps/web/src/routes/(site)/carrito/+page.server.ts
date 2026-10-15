import { fail, redirect } from '@sveltejs/kit';
import { z } from 'zod';
import { api } from '#lib/server/api.js';
import { readCart, setLine, writeCart } from '#lib/server/cart.js';
import type { Product, Quote } from '#lib/server/types.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	const cart = readCart(event.cookies);
	if (cart.lines.length === 0) return { empty: true as const, quote: null, upsells: [], limits: {} };

	const [quote, catalog] = await Promise.all([
		api<Quote>(event, '/checkout/quote', { method: 'POST', body: { lines: cart.lines, deliveryMethod: 'digital', campaignSlug: cart.campaign ?? undefined } }),
		api<{ products: Product[] }>(event, '/public/products')
	]);
	const products = catalog.ok ? catalog.data.products : [];
	const inCart = new Set(cart.lines.map((line) => line.variantId));
	const variantIndex = new Map(products.flatMap((product) => product.variants.map((variant) => [variant.id, { product, variant }] as const)));

	// Extras are offered, never added for the buyer (FR-COM-02).
	const upsells = products
		.filter((product) => product.variants.some((variant) => inCart.has(variant.id)))
		.flatMap((product) => product.upsells)
		.filter((upsell, index, list) => !inCart.has(upsell.variantId) && list.findIndex((other) => other.variantId === upsell.variantId) === index)
		.map((upsell) => {
			const match = variantIndex.get(upsell.variantId);
			return match && match.variant.inStock
				? { variantId: upsell.variantId, name: match.product.name, kind: match.product.kind, pitch: upsell.pitch, priceMinor: match.variant.priceMinor, currency: match.variant.currency }
				: null;
		})
		.filter((upsell) => upsell !== null);

	// The quantity input stops at what one order may carry; the API still decides (FR-COM-02).
	const limits = Object.fromEntries(cart.lines.map((line) => [line.variantId, Math.min(20, variantIndex.get(line.variantId)?.variant.maxPerOrder ?? 20)]));

	return { empty: false as const, quote: quote.ok ? quote.data : null, upsells, limits, campaign: cart.campaign };
};

const updateSchema = z.object({ variantId: z.uuid(), quantity: z.coerce.number().int().min(0).max(20) });

export const actions: Actions = {
	update: async ({ request, cookies }) => {
		const parsed = updateSchema.safeParse(Object.fromEntries(await request.formData()));
		if (!parsed.success) return fail(400, { message: 'Cantidad inválida' });
		writeCart(cookies, setLine(readCart(cookies), parsed.data.variantId, parsed.data.quantity));
		redirect(303, '/carrito');
	},
	add: async ({ request, cookies }) => {
		const parsed = z.object({ variantId: z.uuid() }).safeParse(Object.fromEntries(await request.formData()));
		if (!parsed.success) return fail(400, { message: 'No pudimos agregar ese producto' });
		const cart = readCart(cookies);
		if (!cart.lines.some((line) => line.variantId === parsed.data.variantId)) writeCart(cookies, setLine(cart, parsed.data.variantId, 1));
		redirect(303, '/carrito');
	}
};
