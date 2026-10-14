import { dev } from '$app/env';
import type { Cookies } from '@sveltejs/kit';
import { z } from 'zod';

/**
 * The cart is a list of variant ids and quantities in a cookie: no prices.
 * Every amount shown or charged comes from the API quote (FR-COM-02).
 */
const CART = 'sortea_cart';
const lineSchema = z.object({ variantId: z.uuid(), quantity: z.number().int().min(1).max(20) });
const cartSchema = z.object({ lines: z.array(lineSchema).max(20), campaign: z.string().max(80).nullable() });
export type Cart = z.infer<typeof cartSchema>;

export function readCart(cookies: Cookies): Cart {
	const raw = cookies.get(CART);
	if (!raw) return { lines: [], campaign: null };
	try {
		const parsed = cartSchema.safeParse(JSON.parse(raw));
		return parsed.success ? parsed.data : { lines: [], campaign: null };
	} catch {
		return { lines: [], campaign: null };
	}
}

export function writeCart(cookies: Cookies, cart: Cart) {
	const lines = cart.lines.filter((line) => line.quantity > 0);
	cookies.set(CART, JSON.stringify({ lines, campaign: cart.campaign }), { path: '/', httpOnly: true, secure: !dev, sameSite: 'lax', maxAge: 60 * 60 * 24 * 7 });
}

export function clearCart(cookies: Cookies) {
	cookies.delete(CART, { path: '/' });
}

/** Sets a line quantity, keeping the line where it was; zero removes it. */
export function setLine(cart: Cart, variantId: string, quantity: number): Cart {
	const capped = Math.max(0, Math.min(20, quantity));
	const exists = cart.lines.some((line) => line.variantId === variantId);
	const lines = exists
		? cart.lines.map((line) => (line.variantId === variantId ? { ...line, quantity: capped } : line))
		: [...cart.lines, { variantId, quantity: capped }];
	return { ...cart, lines: lines.filter((line) => line.quantity > 0) };
}

export function cartCount(cart: Cart): number {
	return cart.lines.reduce((sum, line) => sum + line.quantity, 0);
}
