import { describe, expect, it } from 'vitest';
import { calendarDay, campaignDate, dateOnly, dateTime } from './format';

// Draw room S1: every date of the panel and the site is dd/MM/yyyy, with HH:mm (24 h) when a time
// is shown, in the campaign or organization time zone, whatever the Node ICU or the browser.
describe('dates', () => {
	const zone = 'America/Argentina/Buenos_Aires';

	it('shows a date and time as dd/MM/yyyy HH:mm in the time zone', () => {
		expect(dateTime('2026-12-20T23:00:00Z', zone)).toBe('20/12/2026 20:00');
		expect(dateTime('2027-01-10T02:30:00Z', zone)).toBe('09/01/2027 23:30');
	});

	it('shows midnight as 00:00 in the campaign time zone', () => {
		expect(dateTime('2026-12-01T03:00:00Z', zone)).toBe('01/12/2026 00:00');
	});

	it('shows a day alone as dd/MM/yyyy', () => {
		expect(dateOnly('2026-03-05T15:00:00Z', zone)).toBe('05/03/2026');
	});

	it('shows a YYYY-MM-DD day of the API as dd/MM/yyyy', () => {
		expect(calendarDay('2026-11-03')).toBe('03/11/2026');
	});

	it('shows a campaign date, or "A definir" while a draft waits for it', () => {
		expect(campaignDate('2026-11-30T12:00:00Z', zone)).toBe('30/11/2026 09:00');
		expect(campaignDate(null, zone)).toBe('A definir');
	});
});
