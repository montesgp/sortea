import { lineName } from '@sortea/domain';
import { fail, redirect } from '@sveltejs/kit';
import { z } from 'zod';
import { cartSuggestions } from '#lib/cart-suggestions.js';
import type { PublicChances } from '#lib/chances.js';
import { api } from '#lib/server/api.js';
import { readCart, setLine, writeCart } from '#lib/server/cart.js';
import type { Product, Quote } from '#lib/server/types.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	const cart = readCart(event.cookies);
	if (cart.lines.length === 0) return { empty: true as const, quote: null, upsells: [], limits: {}, problemLines: [], chances: null };

	const [quote, catalog] = await Promise.all([
		api<Quote>(event, '/checkout/quote', { method: 'POST', body: { lines: cart.lines, deliveryMethod: 'digital', campaignSlug: cart.campaign ?? undefined } }),
		api<{ products: Product[]; chances: PublicChances | null }>(event, '/public/products')
	]);
	const products = catalog.ok ? catalog.data.products : [];
	// Per-unit chances from the locked rules of the campaign accepting participations, as the shop cards show them.
	const chances = catalog.ok ? catalog.data.chances : null;
	const inCart = new Set(cart.lines.map((line) => line.variantId));
	const variantIndex = new Map(products.flatMap((product) => product.variants.map((variant) => [variant.id, { product, variant }] as const)));

	// Every other product of the campaign, then the configured extras (S5); offered, never added (FR-COM-02).
	const upsells = cartSuggestions(products, chances, [...inCart]);

	// The quantity input stops at what one order may carry; the API still decides (FR-COM-02).
	const limits = Object.fromEntries(cart.lines.map((line) => [line.variantId, Math.min(20, variantIndex.get(line.variantId)?.variant.maxPerOrder ?? 20)]));

	// When the API refuses the cart, every line is still listed with the API's reason, so the buyer can fix it here.
	const problems = quote.ok && !quote.data.ok ? (quote.data.errors ?? []) : [];
	const problemLines = problems.length
		? cart.lines.map((line) => {
				const match = variantIndex.get(line.variantId);
				return {
					variantId: line.variantId,
					quantity: line.quantity,
					name: match ? lineName(match.product.name, match.variant.name) : null,
					problem: problems.find((problem) => problem.variantId === line.variantId) ?? null
				};
			})
		: [];

	return { empty: false as const, quote: quote.ok ? quote.data : null, upsells, limits, campaign: cart.campaign, problemLines, chances };
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
