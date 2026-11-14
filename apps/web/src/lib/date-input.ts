import { isCalendarDate } from '@sortea/domain';
import { fromLocalInput, toLocalInput } from './tz.js';

/**
 * The panel's own date and time fields (draw room S1): people type dd/mm/aaaa
 * and hh:mm (24 h) in text inputs instead of the browser's pickers, whose format
 * follows the browser's language. The server reads the typed text, so the forms
 * work without JavaScript, and turns it into the values the actions used before
 * (`YYYY-MM-DD`, `YYYY-MM-DDTHH:mm` in the campaign or organization time zone).
 */
export type DateInputResult = { ok: true; value: string | null } | { ok: false; message: string };

const DATE_FORMAT = 'Escribí la fecha como dd/mm/aaaa, por ejemplo 25/12/2026';
const TIME_FORMAT = 'Escribí la hora como hh:mm, de 00:00 a 23:59';

/** "25/12/2026" (or a "2026-12-25" of a link written before) as "2026-12-25"; empty is null. */
export function parseDateInput(text: string): DateInputResult {
	const value = text.trim();
	if (!value) return { ok: true, value: null };
	let day: string;
	const typed = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value);
	if (typed) day = `${typed[3]}-${typed[2]!.padStart(2, '0')}-${typed[1]!.padStart(2, '0')}`;
	else if (/^\d{4}-\d{2}-\d{2}$/.test(value)) day = value;
	else return { ok: false, message: DATE_FORMAT };
	return isCalendarDate(day) ? { ok: true, value: day } : { ok: false, message: `La fecha ${value} no existe` };
}

/** "9:05" as "09:05", from 00:00 to 23:59; empty is null. */
export function parseTimeInput(text: string): DateInputResult {
	const value = text.trim();
	if (!value) return { ok: true, value: null };
	const typed = /^(\d{1,2}):(\d{2})$/.exec(value);
	if (!typed || Number(typed[1]) > 23 || Number(typed[2]) > 59) return { ok: false, message: TIME_FORMAT };
	return { ok: true, value: `${typed[1]!.padStart(2, '0')}:${typed[2]}` };
}

/** A typed day and time as "2026-12-25T21:00"; both empty is null, one of them empty is an error. */
export function parseDateTimeInput(date: string, time: string): DateInputResult {
	const day = parseDateInput(date);
	if (!day.ok) return day;
	const hour = parseTimeInput(time);
	if (!hour.ok) return hour;
	if (!day.value && !hour.value) return { ok: true, value: null };
	if (!hour.value) return { ok: false, message: 'Falta la hora (hh:mm)' };
	if (!day.value) return { ok: false, message: 'Falta la fecha (dd/mm/aaaa)' };
	return { ok: true, value: `${day.value}T${hour.value}` };
}

/** The UTC instant of a DateField with a time: `<name>` holds the day and `<name>Time` the time. */
export function readDateTimeField(form: FormData, name: string, timeZone: string, timeName = `${name}Time`): DateInputResult {
	const local = parseDateTimeInput(String(form.get(name) ?? ''), String(form.get(timeName) ?? ''));
	if (!local.ok || !local.value) return local;
	return { ok: true, value: fromLocalInput(local.value, timeZone) };
}

/** What a date field shows: a "2026-12-25" day as "25/12/2026"; anything else (text typed before an error) as it was. */
export function dateFieldValue(value: string | null | undefined): string {
	const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value ?? '');
	return day ? `${day[3]}/${day[2]}/${day[1]}` : (value ?? '');
}

/** What a date-and-time field shows for a stored instant, in the time zone. */
export function dateTimeFieldValue(iso: string | null, timeZone: string): { date: string; time: string } {
	const local = toLocalInput(iso, timeZone);
	return local ? { date: dateFieldValue(local.slice(0, 10)), time: local.slice(11, 16) } : { date: '', time: '' };
}
