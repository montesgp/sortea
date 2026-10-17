import { z } from 'zod';

/**
 * Adding to the cart from a product card or the variant chooser (S4). The
 * form carries a variant and a quantity, never a price: amounts come from the
 * API quote. A line never holds more than the variant allows per order.
 */
export const CART_LINE_CAP = 20;

const addSchema = z.object({
	variantId: z.uuid(),
	quantity: z.coerce.number().int().min(1).max(CART_LINE_CAP).default(1),
	campaign: z
		.string()
		.regex(/^[a-z0-9-]{1,80}$/)
		.optional()
});
export type AddInput = z.infer<typeof addSchema>;

/** Empty fields count as missing: a card posts no quantity and adds one unit. */
export function parseAdd(form: Record<string, unknown>): { ok: true; data: AddInput } | { ok: false } {
	const parsed = addSchema.safeParse({ variantId: form.variantId, quantity: form.quantity || undefined, campaign: form.campaign || undefined });
	return parsed.success ? { ok: true, data: parsed.data } : { ok: false };
}

/** The most one line may hold: the variant's limit per order, within the cart cap. */
export function lineLimit(maxPerOrder: number | undefined): number {
	return Math.min(CART_LINE_CAP, maxPerOrder ?? CART_LINE_CAP);
}

export function addedQuantity(current: number, quantity: number, limit: number): { ok: true; quantity: number } | { ok: false; max: number; message: string } {
	if (current + quantity <= limit) return { ok: true, quantity: current + quantity };
	const held = current > 0 ? ` Ya tenés ${current} en el carrito.` : '';
	return { ok: false, max: limit, message: `Podés llevar hasta ${limit} por compra.${held}` };
}
