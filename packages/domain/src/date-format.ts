/**
 * Dates are shown as dd/MM/yyyy and times as HH:mm on a 24-hour clock, in the
 * campaign or organization time zone (draw room S1). The parts come from
 * formatToParts and are joined here, so no locale decides their order or separators.
 */
const formatters = new Map<string, Intl.DateTimeFormat>();

function parts(instant: string | Date | number, timeZone: string): Record<'day' | 'month' | 'year' | 'hour' | 'minute', string> {
	let formatter = formatters.get(timeZone);
	if (!formatter) {
		formatter = new Intl.DateTimeFormat('en-GB', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
		formatters.set(timeZone, formatter);
	}
	const found = Object.fromEntries(formatter.formatToParts(new Date(instant)).map((part) => [part.type, part.value]));
	return { day: found.day!, month: found.month!, year: found.year!, hour: found.hour!, minute: found.minute! };
}

/** The local day as dd/MM/yyyy, e.g. "09/01/2027". */
export function formatDate(instant: string | Date | number, timeZone: string): string {
	const { day, month, year } = parts(instant, timeZone);
	return `${day}/${month}/${year}`;
}

/** The local day and time as dd/MM/yyyy HH:mm, e.g. "09/01/2027 23:30". */
export function formatDateTime(instant: string | Date | number, timeZone: string): string {
	const { day, month, year, hour, minute } = parts(instant, timeZone);
	return `${day}/${month}/${year} ${hour}:${minute}`;
}
