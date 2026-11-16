import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';
import CheckoutPage from './+page.svelte';

// Checkout in two steps (S1, S2, S4, S5). The server renders the page as it works without
// JavaScript: both steps in one page, every field, one submit. The steps, Continuar, Volver,
// "Cambiar país" and "Borrar mis datos" appear only once the page is interactive.

vi.mock('#lib/server/cart.js', () => ({
	readCart: () => ({ lines: [{ variantId: '00000000-0000-4000-8000-000000000001', quantity: 1 }], campaign: null }),
	clearCart: () => undefined
}));
const api = vi.hoisted(() => vi.fn());
vi.mock('#lib/server/api.js', () => ({ api }));

const { actions } = await import('./+page.server');

const manual = '00000000-0000-4000-8000-000000000001';
const sticker = '00000000-0000-4000-8000-000000000002';
const quote = {
	ok: true,
	currency: 'ARS',
	lines: [{ variantId: manual, name: 'Manual Taller Demo', kind: 'digital', quantity: 2, unitPriceMinor: 600_000, lineTotalMinor: 1_200_000 }],
	subtotalMinor: 1_200_000,
	deliveryFeeMinor: 0,
	totalMinor: 1_200_000,
	requiresDelivery: false,
	chances: null as null | Record<string, unknown>
};
const physical = {
	...quote,
	lines: [...quote.lines, { variantId: sticker, name: 'Calcomanía Taller Demo', kind: 'physical', quantity: 1, unitPriceMinor: 700_000, lineTotalMinor: 700_000 }],
	subtotalMinor: 1_900_000,
	requiresDelivery: true
};
const site = { organization: { name: 'Taller Demo' }, delivery: { pickupEnabled: true, shippingEnabled: false, shippingFeeMinor: 0 } };
const page = (form: unknown = null, data: Record<string, unknown> = {}) =>
	render(CheckoutPage, { props: { data: { quote, countries: ['AR', 'UY'], subdivisions: [], attempt: 'attempt-1', closed: null, site, ...data }, form } as never }).body;
const text = (html: string) => html.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const stepHtml = (html: string, step: 1 | 2) => {
	const start = html.indexOf(`data-step="${step}"`);
	const end = step === 1 ? html.indexOf('data-step="2"') : html.indexOf('</form>');
	return html.slice(html.lastIndexOf('<div', start), end);
};
const names = (html: string) => [...html.matchAll(/<(?:input|select)[^>]*\bname="([^"]+)"/g)].map((match) => match[1]);

describe('checkout in two steps: the markup of each step (S2)', () => {
	it('step 1 says where the purchase is sent and asks email, nombre and apellido, in that order', () => {
		const one = stepHtml(page(), 1);
		expect(text(one)).toContain('¿A dónde te enviamos tu compra?');
		expect(text(one)).toContain('Te mandamos el comprobante, tus descargas y tus cupones a este email.');
		expect(names(one)).toEqual(['email', 'firstName', 'lastName']);
		expect(one).toMatch(/<input[^>]*id="email"[^>]*type="email"[^>]*autocomplete="email"/);
		expect(one).toMatch(/<input[^>]*id="firstName"[^>]*autocomplete="given-name"/);
		expect(one).toMatch(/<input[^>]*id="lastName"[^>]*autocomplete="family-name"/);
		// Nombre and Apellido share a row.
		expect(one).toMatch(/<div class="row[^"]*"><div class="field"><label for="firstName">[\s\S]*<label for="lastName">/);
	});

	it('step 2 asks the last details, says why, notes the privacy and pays the total with Mercado Pago', () => {
		const two = stepHtml(page(), 2);
		expect(text(two)).toContain('Últimos datos');
		expect(text(two)).toContain('Con estos datos identificamos tu compra y te contactamos si hace falta.');
		expect(names(two)).toEqual(['phone', 'documentType', 'documentNumber', 'country', 'province', 'city', 'deliveryMethod', 'terms', 'privacy']);
		expect(two).toMatch(/<label for="phone">WhatsApp \/ teléfono<\/label>/);
		expect(text(two)).toContain('Usamos tus datos para gestionar tu compra, enviarte lo que compraste y contactarte si ganás, según las bases.');
		expect(two).toMatch(/<p class="privacy-note[^"]*"><svg[^>]*aria-hidden="true"/);
		expect(text(two)).toContain('Pagar $ 12.000 con Mercado Pago');
		expect(text(two)).toContain('Vas a pagar en Mercado Pago con los medios que ofrece; no guardamos datos de tu tarjeta.');
	});

	it('names the chances in the reason of step 2 when the purchase gives them', () => {
		const chances = { campaign: { slug: 'moto', title: 'Moto 0 km' }, lines: [{ variantId: manual, chances: 20 }], total: 20, maxPerIdentity: null, remaining: 9000 };
		expect(text(stepHtml(page(null, { quote: { ...quote, chances } }), 2))).toContain('Con estos datos identificamos tu compra y tus chances, y te contactamos si ganás.');
	});

	it('shows the delivery options only when the cart has physical items', () => {
		const digital = stepHtml(page(), 2);
		expect(text(digital)).not.toContain('Entrega');
		expect(digital).toMatch(/<input type="hidden" name="deliveryMethod" value="digital"/);
		const withSticker = stepHtml(page(null, { quote: physical }), 2);
		expect(text(withSticker)).toContain('Entrega');
		expect(withSticker).toMatch(/<input type="radio" name="deliveryMethod" value="pickup"/);
		expect(text(page(null, { quote: physical }))).toContain('Pagar $ 19.000 con Mercado Pago');
	});

	it('has one email field: no confirmation is asked (S5)', () => {
		const html = page();
		expect(html).not.toContain('emailConfirm');
		expect(text(html)).not.toContain('Repetí el email');
	});

	it('sums up the purchase as "Tu compra", with its lines and total', () => {
		const html = page();
		const aside = html.slice(html.indexOf('aria-label="Resumen del pedido"'));
		expect(text(aside.slice(0, aside.indexOf('</aside>')))).toMatch(/^.*Tu compra 2 productos Manual Taller Demo × 2 \$ 12\.000 Total \$ 12\.000/);
	});
});

describe('checkout without JavaScript (progressive enhancement)', () => {
	it('shows every field and both steps in one page that posts as one form', () => {
		const html = page();
		expect(html).toMatch(/<form method="POST"/);
		expect(html).not.toMatch(/<div class="step[^"]*"[^>]*\bhidden\b/);
		expect(html).not.toMatch(/<div class="field[^"]*"[^>]*\bhidden\b/);
		expect(names(html)).toEqual(['attempt', 'email', 'firstName', 'lastName', 'phone', 'documentType', 'documentNumber', 'country', 'province', 'city', 'deliveryMethod', 'terms', 'privacy']);
		// The country is a plain select, not the "Cambiar país" line.
		expect(html).toMatch(/<select id="country" name="country"/);
		expect(text(html)).not.toContain('Cambiar país');
		// No step controls that need JavaScript: one submit, the pay button.
		expect(text(html)).not.toMatch(/Paso \d de 2|Continuar|Volver(?! al carrito)|Borrar mis datos|Ver detalle|Te lo enviamos a/);
		expect(html.match(/<button[^>]*>/g)).toEqual([expect.stringMatching(/class="button pay/)]);
	});

	it('shows the fields of both steps with the server errors after a refused submit', () => {
		const html = page({ values: { email: 'juana@example', firstName: 'Juana', phone: '' }, errors: { email: 'Ingresá un email válido', phone: 'Ingresá tu teléfono: lo usamos para avisarte si ganás' }, message: 'Revisá los datos marcados' });
		expect(text(stepHtml(html, 1))).toContain('Ingresá un email válido');
		expect(text(stepHtml(html, 2))).toContain('Ingresá tu teléfono: lo usamos para avisarte si ganás');
		expect(/<input[^>]*id="firstName"[^>]*>/.exec(html)?.[0]).toContain('value="Juana"');
	});
});

const cookies = { get: () => undefined, getAll: () => [], set: () => undefined, delete: () => undefined, serialize: () => '' };
function submit(fields: Record<string, string>) {
	const body = new FormData();
	for (const [key, value] of Object.entries(fields)) body.set(key, value);
	return actions.default({ request: new Request('http://tallerdemo.localhost/checkout', { method: 'POST', body }), cookies, url: new URL('http://tallerdemo.localhost/checkout') } as never);
}
const filled = { firstName: 'Juana', lastName: 'Pérez', documentType: 'DNI', documentNumber: '30123456', email: 'juana@example.com', phone: '+54 9 11 2345-6789', country: 'AR', province: 'Córdoba', city: 'Río Cuarto', terms: 'on', privacy: 'on' };

describe('checkout server action with one email field (S5)', () => {
	it('sends the purchase without an email confirmation', async () => {
		api.mockReset();
		api.mockResolvedValueOnce({ ok: false, status: 400, code: 'invalid', message: 'No' });
		await submit(filled);
		expect(api).toHaveBeenCalledTimes(1);
		expect(api.mock.calls[0]![2].body.buyer.email).toBe('juana@example.com');
	});

	it('still refuses a malformed email under its field, with the same words as the page', async () => {
		api.mockClear();
		for (const email of ['', 'juana@', 'juana@example']) {
			const result = (await submit({ ...filled, email })) as { status: number; data: { errors: Record<string, string> } };
			expect(result.status).toBe(400);
			expect(result.data.errors).toEqual({ email: 'Ingresá un email válido' });
		}
		expect(api).not.toHaveBeenCalled();
	});

	it('names the step 1 fields with the messages Continuar uses', async () => {
		const result = (await submit({ ...filled, firstName: ' ', lastName: '' })) as { data: { errors: Record<string, string> } };
		expect(result.data.errors).toEqual({ firstName: 'Ingresá tu nombre', lastName: 'Ingresá tu apellido' });
	});
});
