import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import CheckoutPage from './+page.svelte';

// Owner feedback 2026-11-12, S5: the document number shows an example and a format hint for the
// selected type, the same ones as Consultar, next to the existing hint.

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
const page = (form: unknown = null) => render(CheckoutPage, { props: { data: { quote, countries: ['AR'], subdivisions: [], attempt: null, closed: null, site }, form } as never }).body;
const numberInput = (html: string) => /<input[^>]*id="documentNumber"[^>]*>/.exec(html)?.[0] ?? '';

describe('checkout document field (S5)', () => {
	it('renders the DNI example and format by default, keeping the existing hint', () => {
		const html = page();
		const input = numberInput(html);
		expect(input).toContain('placeholder="Ej.: 30123456"');
		expect(input).toContain('inputmode="numeric"');
		expect(input).toContain('aria-describedby="documentNumber-format documentNumber-hint documentNumber-error"');
		expect(html).toMatch(/<p class="hint" id="documentNumber-format">7 u 8 números, sin puntos\.<\/p>/);
		expect(html).toMatch(/<p class="hint" id="documentNumber-hint">Sirve para consultar tus compras\. Nunca se muestra públicamente\.<\/p>/);
	});

	it('follows the type sent back after a failed submit', () => {
		const passport = page({ values: { documentType: 'PASSPORT', documentNumber: 'aa1' }, errors: { documentNumber: 'Revisá el número de documento' } });
		expect(numberInput(passport)).toContain('placeholder="Ej.: AAA123456"');
		expect(numberInput(passport)).toContain('inputmode="text"');
		expect(numberInput(passport)).toContain('autocapitalize="characters"');
		expect(passport).toContain('Letras y números, sin espacios.');
		expect(numberInput(page({ values: { documentType: 'CUIT' } }))).toContain('placeholder="Ej.: 20XXXXXXXXX"');
	});

	it('still posts documentType and documentNumber with the same values', () => {
		const html = page({ values: { documentType: 'CUIT', documentNumber: '27000000000' } });
		expect(html).toMatch(/<select id="documentType" name="documentType"/);
		const select = /<select id="documentType"[\s\S]*?<\/select>/.exec(html)?.[0] ?? '';
		expect([...select.matchAll(/<option value="([A-Z]+)"/g)].map((match) => match[1])).toEqual(['DNI', 'CUIT', 'PASSPORT']);
		expect(select).toMatch(/<option value="CUIT" selected/);
		expect(numberInput(html)).toContain('name="documentNumber"');
		expect(numberInput(html)).toContain('value="27000000000"');
	});
});
