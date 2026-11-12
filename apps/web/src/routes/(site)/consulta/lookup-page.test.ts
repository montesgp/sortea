import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import LookupPage from './+page.svelte';

// Owner feedback 2026-11-11b, S9: "No veo que se asignó". Each purchase in Consultar names its own
// coupons and their campaign, not only the per-campaign summary.

const text = (html: string) =>
	html
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/<[^>]+>/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();

const order = (reference: string, status: string, coupons: unknown) => ({
	id: reference,
	reference,
	status,
	totalMinor: 1_000_000,
	currency: 'ARS',
	createdAt: '2026-11-11T19:07:00Z',
	items: [{ name: 'Calcomanía Taller Demo', quantity: 2, kind: 'physical' }],
	downloads: [],
	coupons
});

describe('lookup order coupons (S9)', () => {
	it('each order lists its coupons with the campaign; one without coupons shows none', () => {
		const coupons = { campaign: 'Moto 0 km', entryDigits: 4, entries: [{ number: 0, status: 'eligible' }, { number: 1, status: 'void' }] };
		const result = {
			holder: { firstName: 'Juana', scope: 'contact' },
			orders: [order('TD-PAID0001', 'paid', coupons), order('TD-WAIT0002', 'pending_payment', null)],
			campaigns: []
		};
		const shown = text(render(LookupPage, { props: { data: { result }, form: null } as never }).body);
		expect(shown).toContain('Tus chances para Moto 0 km (2): N.º 0000, N.º 0001 (anulada)');
		expect(shown.match(/Tus chances para/g)).toHaveLength(1);
	});
});
