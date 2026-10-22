import { describe, expect, it } from 'vitest';
import { dateTime } from './format';

// Node's ICU decides how Intl joins a date and a time ("…, 20:00" in ICU 77, "… a las 20:00" in
// ICU 78); the site's wording must not change with the Node version it is deployed on.
describe('dateTime', () => {
	const zone = 'America/Argentina/Buenos_Aires';

	it('joins the long date and the time with "a las"', () => {
		expect(dateTime('2026-12-20T23:00:00Z', zone)).toBe('20 de diciembre de 2026 a las 20:00');
	});

	it('joins the short date and the time with a comma', () => {
		expect(dateTime('2026-11-30T12:00:00Z', zone, 'short')).toBe('30 nov, 09:00');
	});

	it('shows midnight as 00:00 in the campaign time zone', () => {
		expect(dateTime('2026-12-01T03:00:00Z', zone)).toBe('1 de diciembre de 2026 a las 00:00');
	});
});
