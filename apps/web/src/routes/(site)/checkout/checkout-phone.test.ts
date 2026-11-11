import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';
import CheckoutPage from './+page.svelte';

// Owner feedback 2026-11-10 S8: "El telefono en el form de checkout de carrito lo hacemos
// requerido porque ahi nos tenemos que comunicar para avisar al ganador." The form asks
// for it as required and says why; the server action refuses the purchase without it.

vi.mock('#lib/server/cart.js', () => ({
	readCart: () => ({ lines: [{ variantId: '00000000-0000-4000-8000-000000000001', quantity: 1 }], campaign: null }),
	clearCart: () => undefined
}));
const api = vi.hoisted(() => vi.fn());
vi.mock('#lib/server/api.js', () => ({ api }));

const { actions } = await import('./+page.server');

const quote = {
	ok: true,
	currency: 'ARS',
	lines: [{ variantId: '00000000-0000-4000-8000-000000000001', name: 'Manual Taller Demo', kind: 'digital', quantity: 1, unitPriceMinor: 1_200_000, lineTotalMinor: 1_200_000 }],
	subtotalMinor: 1_200_000,
	deliveryFeeMinor: 0,
	totalMinor: 1_200_000,
	requiresDelivery: false,
	chances: null
};
const site = { organization: { name: 'Taller Demo' }, delivery: { pickupEnabled: false, shippingEnabled: false, shippingFeeMinor: 0 } };

const page = () => render(CheckoutPage, { props: { data: { quote, countries: ['AR'], subdivisions: [], attempt: null, closed: null, site }, form: null } as never }).body;

const cookies = { get: () => undefined, getAll: () => [], set: () => undefined, delete: () => undefined, serialize: () => '' };
function submit(fields: Record<string, string>) {
	const body = new FormData();
	for (const [key, value] of Object.entries(fields)) body.set(key, value);
	return actions.default({ request: new Request('http://tallerdemo.localhost/checkout', { method: 'POST', body }), cookies, url: new URL('http://tallerdemo.localhost/checkout') } as never);
}
const filled = {
	firstName: 'Juana',
	lastName: 'Pérez',
	documentType: 'DNI',
	documentNumber: '30123456',
	email: 'juana@example.com',
	emailConfirm: 'juana@example.com',
	country: 'AR',
	province: 'Córdoba',
	city: 'Río Cuarto',
	terms: 'on',
	privacy: 'on'
};

describe('checkout phone (S8)', () => {
	it('asks for the phone as a required field and says what it is for', () => {
		const html = page();
		const input = /<input[^>]*id="phone"[^>]*>/.exec(html)?.[0] ?? '';
		expect(input).toMatch(/\brequired\b/);
		expect(input).toContain('type="tel"');
		expect(input).toContain('aria-describedby="phone-hint phone-error"');
		expect(html).toMatch(/<label for="phone">Teléfono<\/label>/);
		expect(html).not.toContain('(opcional)');
		expect(html).toMatch(/<p class="hint" id="phone-hint">Lo usamos para avisarte si ganás\.<\/p>/);
	});

	it('refuses a purchase without a phone under its field, without calling the API', async () => {
		api.mockClear();
		for (const phone of [undefined, '', '   ']) {
			const result = (await submit(phone === undefined ? filled : { ...filled, phone })) as { status: number; data: { errors: Record<string, string>; message: string } };
			expect(result.status).toBe(400);
			expect(result.data.errors).toEqual({ phone: 'Ingresá tu teléfono: lo usamos para avisarte si ganás' });
			expect(result.data.message).toBe('Revisá los datos marcados');
		}
		expect(api).not.toHaveBeenCalled();
	});

	it('says how to fix a phone it cannot use', async () => {
		const result = (await submit({ ...filled, phone: 'llamame' })) as { status: number; data: { errors: Record<string, string> } };
		expect(result.status).toBe(400);
		expect(result.data.errors).toEqual({ phone: 'Revisá el teléfono, por ejemplo +54 9 11 2345-6789' });
	});
});
