/**
 * The admin's chances table: one row per product whose value applies to every
 * variant of it (S1, owner feedback 2026-10-22). The rules still store the
 * chances per variant id, so the API, the cart and the draw read them unchanged.
 */
export interface ChanceVariant {
	id: string;
	name: string;
	active: boolean;
	productId: string;
	productName: string;
	productStatus: string;
}

export interface ProductChanceRow {
	productId: string;
	productName: string;
	variantIds: string[];
	onSale: boolean;
	/** The highest value among the variants; the one the form shows and saves for all of them. */
	perUnit: number;
	/** Whether the stored rules give the variants different values. */
	mixed: boolean;
	variants: { name: string; perUnit: number }[];
}

export function productChanceRows(variants: readonly ChanceVariant[], entriesPerUnit: Readonly<Record<string, number>>): ProductChanceRow[] {
	const rows = new Map<string, ProductChanceRow>();
	for (const variant of variants) {
		const perUnit = entriesPerUnit[variant.id] ?? 0;
		let row = rows.get(variant.productId);
		if (!row) {
			row = { productId: variant.productId, productName: variant.productName, variantIds: [], onSale: false, perUnit: 0, mixed: false, variants: [] };
			rows.set(variant.productId, row);
		}
		row.variantIds.push(variant.id);
		row.variants.push({ name: variant.name, perUnit });
		row.onSale ||= variant.productStatus === 'active' && variant.active;
	}
	for (const row of rows.values()) {
		const values = row.variants.map((variant) => variant.perUnit);
		row.perUnit = Math.max(0, ...values);
		row.mixed = values.some((value) => value !== row.perUnit);
	}
	return [...rows.values()];
}

/**
 * The per-variant map from the form: `chances.<productId>` holds the value and
 * one `variant.<productId>` field per variant it applies to. The API validates ids.
 */
export function entriesPerUnitFromProductForm(form: FormData): { ok: true; entriesPerUnit: Record<string, number> } | { ok: false; message: string } {
	const entriesPerUnit: Record<string, number> = {};
	for (const [key, value] of form.entries()) {
		if (!key.startsWith('chances.')) continue;
		const chances = Number(String(value).trim() || '0');
		if (!Number.isInteger(chances) || chances < 0 || chances > 100) {
			return { ok: false, message: 'Las chances por unidad son un número entero de 0 a 100' };
		}
		for (const variantId of form.getAll(`variant.${key.slice('chances.'.length)}`)) entriesPerUnit[String(variantId)] = chances;
	}
	return { ok: true, entriesPerUnit };
}
