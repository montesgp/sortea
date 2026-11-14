import { describe, expect, it } from 'vitest';
import { formatDate, formatDateTime } from '../src/date-format';

const buenosAires = 'America/Argentina/Buenos_Aires';

describe('formatDate', () => {
	it('writes the day as dd/MM/yyyy in the given time zone', () => {
		expect(formatDate('2026-12-20T23:00:00Z', buenosAires)).toBe('20/12/2026');
		expect(formatDate(new Date('2026-12-20T23:00:00Z'), 'UTC')).toBe('20/12/2026');
	});

	it('takes the local day, which can be the day before UTC', () => {
		expect(formatDate('2027-01-10T02:30:00Z', buenosAires)).toBe('09/01/2027');
		expect(formatDate('2027-01-10T02:30:00Z', 'UTC')).toBe('10/01/2027');
	});

	it('zero-pads single-digit days and months', () => {
		expect(formatDate('2026-03-05T15:00:00Z', buenosAires)).toBe('05/03/2026');
	});
});

describe('formatDateTime', () => {
	it('adds the time as HH:mm on a 24-hour clock', () => {
		expect(formatDateTime('2026-12-20T23:00:00Z', buenosAires)).toBe('20/12/2026 20:00');
		expect(formatDateTime('2026-11-13T04:07:00Z', buenosAires)).toBe('13/11/2026 01:07');
	});

	it('shifts date and time to the time zone', () => {
		expect(formatDateTime('2027-01-10T02:30:00Z', buenosAires)).toBe('09/01/2027 23:30');
		expect(formatDateTime('2026-10-25T00:30:00Z', 'Europe/Madrid')).toBe('25/10/2026 02:30');
		expect(formatDateTime('2026-10-25T01:30:00Z', 'Europe/Madrid')).toBe('25/10/2026 02:30');
	});

	it('writes midnight as 00:00 of the day that starts', () => {
		expect(formatDateTime('2026-12-01T03:00:00Z', buenosAires)).toBe('01/12/2026 00:00');
	});

	it('zero-pads single-digit days, months, hours and minutes', () => {
		expect(formatDateTime('2026-02-03T12:05:00Z', buenosAires)).toBe('03/02/2026 09:05');
	});
});
