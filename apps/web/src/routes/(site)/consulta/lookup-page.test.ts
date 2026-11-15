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

	// Owner feedback 2026-11-15b S8: the download did nothing on an iPhone from here while the
	// email's link worked. Each file is now a plain link, like the email's, through the session.
	it('downloads each file through a plain link, not a form', () => {
		const paid = { ...order('TD-PAID0001', 'paid', null), id: '00000000-0000-4000-8000-0000000000aa', downloads: [{ assetId: '00000000-0000-4000-8000-0000000000bb', filename: 'TallerDemo-calcomania.png' }] };
		const html = render(LookupPage, { props: { data: { result: { holder: { firstName: 'Juana', scope: 'contact' }, orders: [paid], campaigns: [] } }, form: null } as never }).body;
		expect(html).toMatch(/<a class="button download[^"]*" href="\/consulta\/descargar\/00000000-0000-4000-8000-0000000000aa\/00000000-0000-4000-8000-0000000000bb">Descargar TallerDemo-calcomania\.png<\/a>/);
		expect(html).not.toContain('action="?/download"');
	});
});

// Owner feedback 2026-11-12, S4: the page never claims a code was sent, since the document may have
// no purchases (the API answers the same either way, FR-ENTRY-03). S5: the number field shows the
// same example and format as the checkout, for the default type.
const startPage = (form: unknown = null) => render(LookupPage, { props: { data: {}, form } as never }).body;
const numberInput = (html: string) => /<input[^>]*id="documentNumber"[^>]*>/.exec(html)?.[0] ?? '';

describe('lookup by document (S4, S5)', () => {
	it('says the code goes to the purchase email only when the document has purchases', () => {
		const shown = text(startPage());
		// Owner feedback 2026-11-15b S4: a code at each email the document bought with, each opening its own purchases.
		expect(shown).toContain(
			'Si tu documento tiene compras, te enviamos un código a cada email que usaste al comprar. Con el código del email de tu primera compra ves todas tus compras; con el de otro email, las que hiciste con ese email.'
		);
		expect(shown).not.toContain('Te enviamos un código al email que usaste al comprar.');
	});

	it('the verify step shows the API message as is', () => {
		const message = 'Si el documento tiene compras registradas, enviamos un código de 6 dígitos a cada email que usaste al comprar.';
		const shown = text(startPage({ step: 'verify', challengeId: 'c1', message }));
		expect(shown).toContain(message);
		expect(shown).not.toContain('Te enviamos');
	});

	it('the number field shows the DNI example and format', () => {
		const html = startPage();
		const input = numberInput(html);
		expect(input).toContain('placeholder="Ej.: 30123456"');
		expect(input).toContain('inputmode="numeric"');
		expect(input).toContain('aria-describedby="documentNumber-format"');
		// Owner feedback 2026-11-15b S1: the requirements of the type, ticked while typed, as in checkout.
		const list = /<ul[^>]*id="documentNumber-format"[^>]*>([\s\S]*?)<\/ul>/.exec(html)?.[1] ?? '';
		expect(text(list)).toBe('7 u 8 números');
		expect(list).not.toMatch(/class="[^"]*\bok\b/);
		expect(input).not.toMatch(/class="[^"]*\bvalid\b/);
	});

	it('still posts documentType and documentNumber to the start action', () => {
		const html = startPage();
		expect(html).toMatch(/<form method="POST" action="\?\/start"/);
		const select = /<select id="documentType"[\s\S]*?<\/select>/.exec(html)?.[0] ?? '';
		expect(select).toContain('name="documentType"');
		expect([...select.matchAll(/<option value="([A-Z]+)"[^>]*>([^<]+)</g)].map((match) => [match[1], match[2]])).toEqual([
			['DNI', 'DNI'],
			['CUIT', 'CUIT'],
			['PASSPORT', 'Pasaporte']
		]);
		expect(numberInput(html)).toContain('name="documentNumber"');
		expect(numberInput(html)).toMatch(/\brequired\b/);
	});
});
