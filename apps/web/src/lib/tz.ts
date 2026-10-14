/**
 * Conversions between UTC instants and `datetime-local` input values in a
 * campaign's time zone. Admins type local times; the API stores UTC.
 */
function offsetMinutes(instant: Date, timeZone: string): number {
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone,
		hourCycle: 'h23',
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit'
	}).formatToParts(instant);
	const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
	const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
	return Math.round((asUtc - instant.getTime()) / 60_000);
}

export function toLocalInput(iso: string | null, timeZone: string): string {
	if (!iso) return '';
	const instant = new Date(iso);
	const local = new Date(instant.getTime() + offsetMinutes(instant, timeZone) * 60_000);
	return local.toISOString().slice(0, 16);
}

export function fromLocalInput(value: string, timeZone: string): string | null {
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
	const guess = new Date(`${value}:00Z`);
	const offset = offsetMinutes(guess, timeZone);
	return new Date(guess.getTime() - offset * 60_000).toISOString();
}
