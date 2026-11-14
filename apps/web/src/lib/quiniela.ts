import { parseDateTimeInput, type DateInputResult } from './date-input.js';
import { dateTime } from './format.js';
import { fromLocalInput } from './tz.js';

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

/** The official date (dd/mm/aaaa) and time (hh:mm) typed in the campaign time zone, as a UTC instant; both are required. */
export function drawnAtFromInput(date: string, time: string, timeZone: string): DateInputResult {
	if (!date.trim() || !time.trim()) return { ok: false, message: 'Indicá la fecha y la hora oficial del sorteo' };
	const local = parseDateTimeInput(date, time);
	return local.ok && local.value ? { ok: true, value: fromLocalInput(local.value, timeZone) } : local;
}

/** "29/11/2026 21:00" in the campaign time zone. */
export function drawnAtLabel(iso: string, timeZone: string): string {
	return dateTime(iso, timeZone);
}

/** The `?ronda=` of a manifest download: a positive round number, or null for the latest manifest (ADR 0014 §5). */
export function manifestRound(value: string | null): number | null {
	if (value === null || !/^[1-9]\d{0,4}$/.test(value)) return null;
	return Number(value);
}

/** "Moto, $100.000 (2 unidades)": each vacant prize once, with how many of its units are vacant. */
export function vacantPrizesLabel(slots: readonly { prize: string; slot: number }[]): string {
	const counts = new Map<string, number>();
	for (const { prize } of slots) counts.set(prize, (counts.get(prize) ?? 0) + 1);
	return [...counts].map(([prize, units]) => (units === 1 ? prize : `${prize} (${units} unidades)`)).join(', ');
}
