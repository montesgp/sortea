/** A day written as YYYY-MM-DD that exists in the calendar. */
export function isCalendarDate(value: string): boolean {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
	if (!match) return false;
	const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
	const date = new Date(Date.UTC(year, month - 1, day));
	return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** Milliseconds the zone is ahead of UTC at that instant. */
function zoneOffset(instant: number, timezone: string): number {
	const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(instant);
	const part = (type: string) => Number(parts.find((p) => p.type === type)!.value);
	return Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'), part('second')) - Math.floor(instant / 1000) * 1000;
}

/** The instant a local day starts in the time zone. */
function zonedMidnight(day: string, timezone: string): Date {
	const [year, month, date] = day.split('-').map(Number) as [number, number, number];
	const wall = Date.UTC(year, month - 1, date);
	// Correct twice: the offset at the guess can differ from the one at midnight across a DST change.
	let instant = wall - zoneOffset(wall, timezone);
	instant = wall - zoneOffset(instant, timezone);
	return new Date(instant);
}

/**
 * Bounds for a "Desde"/"Hasta" filter of whole local days (S3, S5): `start` is
 * inclusive, `end` exclusive (the start of the day after `to`). Callers check
 * the days with `isCalendarDate` first.
 */
export function zonedDayRange(from: string | undefined, to: string | undefined, timezone: string): { start: Date | null; end: Date | null } {
	let end: Date | null = null;
	if (to) {
		const [year, month, date] = to.split('-').map(Number) as [number, number, number];
		end = zonedMidnight(new Date(Date.UTC(year, month - 1, date + 1)).toISOString().slice(0, 10), timezone);
	}
	return { start: from ? zonedMidnight(from, timezone) : null, end };
}
