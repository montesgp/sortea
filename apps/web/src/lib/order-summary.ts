import { formatEntryNumber } from '@sortea/domain';
import { dateTime, money } from '#lib/format.js';

/** What "Copiar resumen" puts in plain text (owner feedback 2026-11-11b, S1). Never the access code. */
export interface OrderSummary {
	site: string;
	reference: string;
	createdAt: string;
	timezone: string;
	currency: string;
	totalMinor: number;
	items: readonly { name: string; quantity: number }[];
	coupons: { campaign: string; entryDigits: number; numbers: readonly number[] } | null;
}

export function orderSummaryText(summary: OrderSummary): string {
	const lines = [
		summary.site,
		`Compra ${summary.reference}`,
		`Fecha: ${dateTime(summary.createdAt, summary.timezone)}`,
		...summary.items.map((item) => `${item.name} × ${item.quantity}`),
		`Total: ${money(summary.totalMinor, summary.currency)}`
	];
	const coupons = summary.coupons;
	if (coupons?.numbers.length) {
		lines.push(`Tus chances para ${coupons.campaign} (${coupons.numbers.length}): ${coupons.numbers.map((number) => formatEntryNumber(number, coupons.entryDigits)).join(', ')}`);
	}
	return lines.join('\n');
}

/** Copies through the clipboard when the browser allows it; otherwise the page shows the text to select. */
export async function copyText(text: string, clipboard: Pick<Clipboard, 'writeText'> | undefined): Promise<'copied' | 'fallback'> {
	if (!clipboard) return 'fallback';
	try {
		await clipboard.writeText(text);
		return 'copied';
	} catch {
		return 'fallback';
	}
}
