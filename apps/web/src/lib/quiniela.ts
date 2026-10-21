import { fromLocalInput } from './tz';

/** Spanish copy and form helpers for the Quiniela draw (ADR 0014 §3-§4). */

export type ParsedExtracts = { ok: true; extracts: number[] } | { ok: false; message: string };

/**
 * The 20 extracts as pasted from the official result: separated by spaces,
 * commas, semicolons or new lines, zero-padded or not, optionally numbered
 * ("1. 0042"). Their order is the official one.
 */
export function parseExtracts(value: string): ParsedExtracts {
	const tokens = value
		.split(/[\s,;]+/)
		.filter(Boolean)
		// "1." or "1.º" before a number is its position, not an extract.
		.filter((token) => !/^\d{1,2}(\.º?|º)$/.test(token));
	const extracts: number[] = [];
	for (const token of tokens) {
		if (!/^\d{1,4}$/.test(token)) return { ok: false, message: `"${token}" no es un número de 4 cifras` };
		extracts.push(Number(token));
	}
	if (extracts.length !== 20) return { ok: false, message: `Cargá los 20 extractos: hay ${extracts.length}` };
	return { ok: true, extracts };
}

/** "1.º", "20.º". */
export function ordinal(position: number): string {
	return `${position}.º`;
}

/** What an extract did, for the extracts that gave no award. */
export const extractOutcomeLabel: Record<string, string> = {
	no_match: 'Sin coincidencia',
	repeated: 'Repetido, no cuenta',
	// The coupon already holds an award, as winner or alternate.
	already_awarded: 'Ya figura en otro premio',
	spare: 'Coincide, sin unidades por cubrir'
};

/** The official date and time typed in the campaign time zone, as a UTC instant; null when either is missing. */
export function drawnAtFromInput(date: string, time: string, timeZone: string): string | null {
	return date && time ? fromLocalInput(`${date}T${time}`, timeZone) : null;
}

/** "29/11/2026 a las 21:00" in the campaign time zone. */
export function drawnAtLabel(iso: string, timeZone: string): string {
	const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(iso));
	const part = (type: string) => parts.find((candidate) => candidate.type === type)?.value ?? '';
	return `${part('day')}/${part('month')}/${part('year')} a las ${part('hour')}:${part('minute')}`;
}
