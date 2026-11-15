import { describe, expect, it } from 'vitest';
import { transparencyBack, transparencyHref } from './back-link.js';

// Owner feedback 2026-11-15 S4: "Transparencia y bases" opened from the shop
// goes back to the shop; from anywhere else, back to the campaign.

describe('transparency back link (S4)', () => {
	it('marks the link that leaves the shop', () => {
		expect(transparencyHref('honda-wave', 'tienda')).toBe('/sorteos/honda-wave/transparencia?desde=tienda');
		expect(transparencyHref('honda-wave')).toBe('/sorteos/honda-wave/transparencia');
	});

	it('goes back to the shop only when the visit came from it', () => {
		expect(transparencyBack('honda-wave', 'tienda')).toEqual({ href: '/tienda', label: 'Volver a la tienda' });
		for (const from of [null, '', 'https://evil.test', '/carrito', 'TIENDA']) {
			expect(transparencyBack('honda-wave', from), String(from)).toEqual({ href: '/sorteos/honda-wave', label: 'Volver a la campaña' });
		}
	});
});
