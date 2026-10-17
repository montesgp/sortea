import { fail, redirect, type RequestEvent } from '@sveltejs/kit';
import { addedQuantity, lineLimit, parseAdd } from '#lib/cart-add.js';
import { api } from '#lib/server/api.js';
import { readCart, setLine, writeCart } from '#lib/server/cart.js';
import type { Product } from '#lib/server/types.js';

/**
 * Adds a quantity of one variant to the cart cookie (S4), shared by the shop
 * and the product page so a refusal is shown where the buyer chose. Amounts
 * still come from the API quote.
 */
export async function addToCart(event: RequestEvent) {
	const parsed = parseAdd(Object.fromEntries(await event.request.formData()));
	if (!parsed.ok) return fail(400, { message: 'No pudimos agregar ese producto' });
	const { variantId, quantity, campaign } = parsed.data;
	// The catalog gives the limit per order; if the API is down the cart cap applies and the quote decides later.
	const catalog = await api<{ products: Product[] }>(event, '/public/products');
	const variant = catalog.ok ? catalog.data.products.flatMap((product) => product.variants).find((option) => option.id === variantId) : undefined;
	if (catalog.ok && !variant) return fail(400, { message: 'No pudimos agregar ese producto' });
	if (variant && !variant.inStock) return fail(400, { message: 'Esa opción no tiene stock.' });

	const cart = readCart(event.cookies);
	const current = cart.lines.find((line) => line.variantId === variantId)?.quantity ?? 0;
	const added = addedQuantity(current, quantity, lineLimit(variant?.maxPerOrder));
	if (!added.ok) return fail(400, { message: added.message, max: added.max });
	writeCart(event.cookies, { ...setLine(cart, variantId, added.quantity), campaign: campaign ?? cart.campaign });
	redirect(303, '/carrito');
}
