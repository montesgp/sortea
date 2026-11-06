import { describe, expect, it } from 'vitest';
import { isCalendarDate, zonedDayRange } from '../src/dates';

describe('isCalendarDate', () => {
	it('accepts real days written as YYYY-MM-DD', () => {
		expect(isCalendarDate('2026-11-06')).toBe(true);
		expect(isCalendarDate('2024-02-29')).toBe(true);
	});

	it('refuses other shapes and days that do not exist', () => {
		for (const value of ['2026-02-30', '2025-02-29', '2026-13-01', '2026-1-5', '06/11/2026', '2026-11-06T00:00', '']) {
			expect(isCalendarDate(value)).toBe(false);
		}
	});
});

describe('zonedDayRange', () => {
	it('covers whole local days in the organization time zone, end exclusive', () => {
		expect(zonedDayRange('2026-11-01', '2026-11-06', 'America/Argentina/Buenos_Aires')).toEqual({
			start: new Date('2026-11-01T03:00:00.000Z'),
			end: new Date('2026-11-07T03:00:00.000Z')
		});
	});

	it('leaves an open side unbounded', () => {
		expect(zonedDayRange('2026-11-01', undefined, 'UTC')).toEqual({ start: new Date('2026-11-01T00:00:00.000Z'), end: null });
		expect(zonedDayRange(undefined, '2026-11-01', 'UTC')).toEqual({ start: null, end: new Date('2026-11-02T00:00:00.000Z') });
		expect(zonedDayRange(undefined, undefined, 'UTC')).toEqual({ start: null, end: null });
	});

	it('follows daylight saving changes', () => {
		// Madrid moves from UTC+2 to UTC+1 on 2026-10-25: that day lasts 25 hours.
		expect(zonedDayRange('2026-10-25', '2026-10-25', 'Europe/Madrid')).toEqual({
			start: new Date('2026-10-24T22:00:00.000Z'),
			end: new Date('2026-10-25T23:00:00.000Z')
		});
	});

	it('crosses month and year ends', () => {
		expect(zonedDayRange('2026-12-31', '2026-12-31', 'America/Argentina/Buenos_Aires').end).toEqual(new Date('2027-01-01T03:00:00.000Z'));
	});
});
