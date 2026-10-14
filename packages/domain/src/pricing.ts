import { addMoney, money, multiplyMoney, type CurrencyCode, type Money } from './money';

/**
 * Server-side price calculation. The browser only ever sends variant ids and
 * quantities; every amount is recomputed here from the tenant catalog
 * (FR-COM-02, FR-COM-04). Prices are final consumer prices (taxes included).
 */
export type ProductKind = 'digital' | 'physical';

export interface CatalogEntry {
	readonly productId: string;
	readonly variantId: string;
	readonly name: string;
	readonly kind: ProductKind;
	readonly unitPriceMinor: number;
	readonly currency: CurrencyCode;
	readonly active: boolean;
	/** `null` means stock is not tracked for this variant. */
	readonly stock: number | null;
	readonly maxPerOrder: number;
	readonly availableFrom: Date | null;
	readonly availableUntil: Date | null;
}

export interface CartLineInput {
	readonly variantId: string;
	readonly quantity: number;
}

export interface PricedLine {
	readonly productId: string;
	readonly variantId: string;
	readonly name: string;
	readonly kind: ProductKind;
	readonly quantity: number;
	readonly unitPrice: Money;
	readonly lineTotal: Money;
}

export type CartError =
	| { code: 'empty_cart' }
	| { code: 'duplicate_line'; variantId: string }
	| { code: 'unknown_variant'; variantId: string }
	| { code: 'inactive_variant'; variantId: string }
	| { code: 'not_available_now'; variantId: string }
	| { code: 'invalid_quantity'; variantId: string }
	| { code: 'over_max_per_order'; variantId: string; max: number }
	| { code: 'insufficient_stock'; variantId: string; available: number }
	| { code: 'mixed_currency' };

export type PricedCart =
	| {
			ok: true;
			currency: CurrencyCode;
			lines: PricedLine[];
			subtotal: Money;
			deliveryFee: Money;
			total: Money;
			requiresDelivery: boolean;
	  }
	| { ok: false; errors: CartError[] };

export interface PriceCartOptions {
	readonly now: Date;
	/** Fee for the delivery method the buyer chose; ignored when no physical items are present. */
	readonly deliveryFeeMinor?: number;
}

export function priceCart(
	lines: readonly CartLineInput[],
	catalog: ReadonlyMap<string, CatalogEntry>,
	options: PriceCartOptions
): PricedCart {
	if (lines.length === 0) return { ok: false, errors: [{ code: 'empty_cart' }] };

	const errors: CartError[] = [];
	const seen = new Set<string>();
	const priced: PricedLine[] = [];

	for (const line of lines) {
		if (seen.has(line.variantId)) {
			errors.push({ code: 'duplicate_line', variantId: line.variantId });
			continue;
		}
		seen.add(line.variantId);

		const entry = catalog.get(line.variantId);
		if (!entry) {
			errors.push({ code: 'unknown_variant', variantId: line.variantId });
			continue;
		}
		const lineError = validateLine(line, entry, options.now);
		if (lineError) {
			errors.push(lineError);
			continue;
		}
		const unitPrice = money(entry.unitPriceMinor, entry.currency);
		priced.push({
			productId: entry.productId,
			variantId: entry.variantId,
			name: entry.name,
			kind: entry.kind,
			quantity: line.quantity,
			unitPrice,
			lineTotal: multiplyMoney(unitPrice, line.quantity)
		});
	}

	const currencies = new Set(priced.map((line) => line.unitPrice.currency));
	if (currencies.size > 1) errors.push({ code: 'mixed_currency' });
	if (errors.length > 0) return { ok: false, errors };

	const currency = priced[0]!.unitPrice.currency;
	const subtotal = priced.reduce((sum, line) => addMoney(sum, line.lineTotal), money(0, currency));
	const requiresDelivery = priced.some((line) => line.kind === 'physical');
	const deliveryFee = money(requiresDelivery ? (options.deliveryFeeMinor ?? 0) : 0, currency);

	return {
		ok: true,
		currency,
		lines: priced,
		subtotal,
		deliveryFee,
		total: addMoney(subtotal, deliveryFee),
		requiresDelivery
	};
}

function validateLine(line: CartLineInput, entry: CatalogEntry, now: Date): CartError | null {
	const variantId = line.variantId;
	if (!entry.active) return { code: 'inactive_variant', variantId };
	if (entry.availableFrom && now < entry.availableFrom) return { code: 'not_available_now', variantId };
	if (entry.availableUntil && now >= entry.availableUntil) return { code: 'not_available_now', variantId };
	if (!Number.isSafeInteger(line.quantity) || line.quantity < 1) return { code: 'invalid_quantity', variantId };
	if (line.quantity > entry.maxPerOrder) return { code: 'over_max_per_order', variantId, max: entry.maxPerOrder };
	if (entry.stock !== null && line.quantity > entry.stock) {
		return { code: 'insufficient_stock', variantId, available: entry.stock };
	}
	return null;
}
