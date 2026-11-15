import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import DateField from './DateField.svelte';

// Owner feedback 2026-11-15b S10, S12: the day is still typed as dd/mm/aaaa, and a calendar
// button next to it opens the browser's picker to choose it; the time input is wide enough to
// show hh:mm whole.

const field = (props: Record<string, unknown>) => render(DateField, { props: props as never }).body;

describe('date field (2026-11-15b)', () => {
	it('offers a calendar next to a typed day', () => {
		const html = field({ id: 'from', name: 'from', kind: 'date', date: '15/11/2026' });
		expect(html).toMatch(/<input id="from" name="from"[^>]*type="text"[^>]*value="15\/11\/2026"/);
		expect(html).toMatch(/<button type="button"[^>]*aria-label="Elegir la fecha en el calendario"/);
		// The browser's picker stays out of the form and of the tab order: only the typed day is sent.
		const picker = /<input[^>]*type="date"[^>]*>/.exec(html)?.[0] ?? '';
		expect(picker).toContain('tabindex="-1"');
		expect(picker).toContain('aria-hidden="true"');
		expect(picker).toContain('value="2026-11-15"');
		expect(picker).not.toContain('name=');
	});

	it('also next to the day of a date-and-time field, and never next to a time alone', () => {
		expect(field({ id: 'drawAt', name: 'drawAt', date: '09/01/2027', time: '21:00' })).toContain('aria-label="Elegir la fecha en el calendario"');
		expect(field({ id: 'at', name: 'at', kind: 'time', time: '21:00' })).not.toContain('calendario');
	});

	it('gives the time its own width class, so hh:mm is not cut', () => {
		expect(field({ id: 'drawAt', name: 'drawAt', date: '09/01/2027', time: '04:07' })).toMatch(/<input id="drawAt-time"[^>]*class="[^"]*\btime\b/);
		expect(field({ id: 'at', name: 'at', kind: 'time', time: '04:07' })).toMatch(/<input id="at"[^>]*class="[^"]*\btime\b/);
	});
});
