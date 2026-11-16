import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import OrderPage from './+page.svelte';

// Owner feedback 2026-11-11b, S9: the back-office order names the campaign of its coupons.

const text = (html: string) =>
	html
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/<[^>]+>/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();

const order = {
	id: 'o1',
	reference: 'TD-1',
	status: 'paid',
	currency: 'ARS',
	subtotalMinor: 100,
	deliveryFeeMinor: 0,
	totalMinor: 100,
	deliveryMethod: 'digital',
	createdAt: '2026-10-25T15:00:00Z',
	paidAt: '2026-10-25T15:01:00Z',
	piiVisible: false,
	buyer: { firstName: 'Juana', lastName: 'P.', email: 'ju***@example.com', phone: null, province: null, city: null, document: null, address: null },
	items: [],
	payments: [],
	entries: [
		{ number: 0, status: 'eligible' },
		{ number: 1, status: 'eligible' }
	],
	entryDigits: 4,
	campaignTitle: 'Moto 0 km',
	consents: []
};

describe('admin order coupons (S9)', () => {
	it('shows the coupon numbers with their campaign', () => {
		const session = { organization: { timezone: 'America/Argentina/Buenos_Aires' }, permissions: ['orders.view'] };
		const shown = text(render(OrderPage, { props: { data: { order, session }, form: null } as never }).body);
		expect(shown).toContain('Cupones de Moto 0 km (2): N.º 0000, N.º 0001');
	});
});

// Owner feedback 2026-11-14 S3: no withdrawal of the winner publicity consent; a decision stored before stays readable.
describe('admin order consents (S3)', () => {
	it('lists an old winner publicity decision as no longer applied, and offers no withdrawal', () => {
		const session = { organization: { timezone: 'America/Argentina/Buenos_Aires' }, permissions: ['orders.view'] };
		const old = {
			...order,
			piiVisible: true,
			consents: [{ purpose: 'winner_publicity', granted: true, policyVersion: 'p1', recordedAt: '2026-10-25T15:00:00Z' }],
			winnerPublicity: { publishable: true, withdrawable: true, withdrawnAt: null }
		};
		const html = render(OrderPage, { props: { data: { order: old, session }, form: null } as never }).body;
		expect(text(html)).toContain('Publicar identidad si gana (registro anterior, ya no se aplica) Otorgado');
		expect(html).not.toContain('withdrawPublicity');
		expect(text(html)).not.toMatch(/Retirar autorización|se publican nombre, ciudad y chances|no se publica su identidad/);
	});
});
