/** Admin catalog helpers: es-AR amounts typed by people, and Spanish labels. */

/**
 * Parses an amount typed in es-AR format into minor units without floating
 * point: "12.000" → 1_200_000, "12000,5" → 1_200_050, "$ 1.234,56" → 123_456.
 * A lone dot followed by one or two digits ("12.5") is read as a decimal
 * separator, which is what people paste from other tools. Returns null when
 * the text is not an amount.
 */
export function parseMoneyInput(text: string): number | null {
	const clean = text.replace(/[$\s]/g, '');
	if (!clean) return null;
	let units: string;
	let fraction = '';
	const comma = /^(\d{1,3}(?:\.\d{3})+|\d+),(\d{1,2})$/.exec(clean);
	const dotDecimal = /^(\d+)\.(\d{1,2})$/.exec(clean);
	if (comma) {
		units = comma[1]!.replaceAll('.', '');
		fraction = comma[2]!;
	} else if (/^\d{1,3}(?:\.\d{3})+$/.test(clean)) {
		units = clean.replaceAll('.', '');
	} else if (dotDecimal) {
		units = dotDecimal[1]!;
		fraction = dotDecimal[2]!;
	} else if (/^\d+$/.test(clean)) {
		units = clean;
	} else {
		return null;
	}
	const minor = Number(units) * 100 + Number(fraction.padEnd(2, '0') || '0');
	return Number.isSafeInteger(minor) ? minor : null;
}

/** Minor units as the text an input should show: 1_200_050 → "12000,50", 1_200_000 → "12000". */
export function minorToInput(minor: number): string {
	const units = Math.trunc(minor / 100);
	const cents = Math.abs(minor % 100);
	return cents === 0 ? String(units) : `${units},${String(cents).padStart(2, '0')}`;
}

export const productStatusLabel: Record<string, { label: string; tone: 'ok' | 'warn' | 'bad' | 'neutral' }> = {
	draft: { label: 'Borrador', tone: 'neutral' },
	active: { label: 'A la venta', tone: 'ok' },
	archived: { label: 'Archivado', tone: 'warn' }
};

export const productKindLabel: Record<string, string> = { digital: 'Digital', physical: 'Físico' };
