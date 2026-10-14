import { describe, expect, it } from 'vitest';
import { fromLocalInput, toLocalInput } from './tz';

describe('campaign time zone inputs', () => {
	const tz = 'America/Argentina/Buenos_Aires';

	it('shows UTC instants as local wall time', () => {
		expect(toLocalInput('2026-11-29T01:00:00.000Z', tz)).toBe('2026-11-28T22:00');
	});

	it('round-trips local input back to the same instant', () => {
		expect(fromLocalInput('2026-11-28T22:00', tz)).toBe('2026-11-29T01:00:00.000Z');
		expect(fromLocalInput('not a date', tz)).toBeNull();
	});
});
