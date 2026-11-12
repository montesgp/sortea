import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import ResultPage from './+page.svelte';

// Owner feedback 2026-11-08: "Volver a la tienda" in Mercado Pago lands on this page
// without paying. While the order waits, the page must not claim a payment is on its
// way: it says how a paid order and an unpaid one end, and offers a new purchase.
// An unpaid order is never resumed; it expires on its own (ADR 0014 §1).

const text = (html: string) =>
	html
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/<[^>]+>/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();

const order = (status: string) => ({
	reference: 'MG-NBAK33CK',
	status,
	totalMinor: 700_000,
	currency: 'ARS',
	email: 'te***@testuser.com',
	items: [{ name: 'Calcomanía Taller Demo', quantity: 1, kind: 'physical', lineTotalMinor: 700_000 }],
	entries: [],
	entryDigits: 4
});

const page = (status: string) => render(ResultPage, { props: { data: { order: order(status), accessCode: 'Y6GZQ6SUXF' } } as never }).body;

describe('checkout result page', () => {
	it('while waiting, explains both outcomes and offers a new purchase instead of resuming the order', () => {
		const html = page('pending_payment');
		const shown = text(html);
		expect(shown).toContain('Estamos esperando la confirmación de Mercado Pago');
		expect(shown).toContain('Si ya pagaste, suele tardar unos segundos y esta página se actualiza sola: no pagues de nuevo.');
		expect(shown).toContain('Si no llegaste a pagar, este pedido vence solo y no se te cobra nada. Podés hacer una compra nueva.');
		expect(shown).not.toContain('no hace falta que pagues de nuevo');
		expect(html).toMatch(/<a class="button[^"]*" href="\/tienda">Volver a la tienda<\/a>/);
	});

	it('says the chances the purchase gives while it waits and once paid, highlighted (console polish 2026-11-11, S7)', () => {
		const render_ = (status: string, extra: Record<string, unknown>) =>
			render(ResultPage, { props: { data: { order: { ...order(status), ...extra }, accessCode: 'Y6GZQ6SUXF' } } as never }).body;
		const waiting = render_('pending_payment', { chances: { count: 6, campaign: 'Moto 0 km' } });
		expect(waiting).toContain('chances-badge');
		expect(text(waiting)).toContain('+6 chances para Moto 0 km');
		const paid = render_('paid', { chances: { count: 2, campaign: 'Moto 0 km' }, entries: [7, 8] });
		expect(text(paid)).toContain('+2 chances para Moto 0 km');
		expect(text(paid)).toContain('Tus chances (2): N.º 0007, N.º 0008');
		expect(render_('expired', { chances: null })).not.toContain('chances-badge');
	});

	it('a paid order offers "Copiar resumen" (owner feedback 2026-11-11b, S1)', () => {
		const html = render(ResultPage, { props: { data: { order: { ...order('paid'), entries: [7, 8], chances: { count: 2, campaign: 'Moto 0 km' } }, accessCode: 'Y6GZQ6SUXF' } } as never }).body;
		expect(html).toMatch(/<button[^>]*type="button"[^>]*>Copiar resumen<\/button>/);
		expect(html).toMatch(/role="status"/);
		expect(text(page('pending_payment'))).not.toContain('Copiar resumen');
	});

	it('an expired order says the payment was not confirmed in time and how to reach the site (S7)', () => {
		const site = { organization: { name: 'Taller Demo', timezone: 'America/Argentina/Buenos_Aires' }, contact: { whatsapp: '+54 9 11 2345-6789', email: 'hola@tallerdemo.test' } };
		const html = render(ResultPage, { props: { data: { order: order('expired'), accessCode: 'Y6GZQ6SUXF', site } } as never }).body;
		const shown = text(html);
		expect(shown).toContain('El pago no se confirmó a tiempo');
		expect(shown).toContain('Este pedido venció sin que nos llegara la confirmación de Mercado Pago.');
		expect(shown).toContain('Si Mercado Pago te cobró, no compres de nuevo: escribinos con el comprobante MG-NBAK33CK y lo revisamos.');
		expect(html).toContain('href="https://wa.me/5491123456789?text=');
		expect(html).toContain('href="mailto:hola@tallerdemo.test');
		expect(shown).toContain('Si no llegaste a pagar, no se te cobró nada. Podés hacer una compra nueva.');
		expect(shown).not.toContain('No encontramos');
	});

	it('an expired order without contact channels points to the site contact without a broken link', () => {
		const site = { organization: { name: 'Taller Demo', timezone: 'America/Argentina/Buenos_Aires' }, contact: {} };
		const html = render(ResultPage, { props: { data: { order: order('expired'), accessCode: 'Y6GZQ6SUXF', site } } as never }).body;
		expect(text(html)).toContain('Escribinos por los canales de contacto de este sitio.');
		expect(html).not.toContain('wa.me');
		expect(html).not.toContain('mailto:');
	});

	it('when the browser holds the order but its status cannot be read now, it says so instead of "No encontramos" (S7)', () => {
		const html = render(ResultPage, { props: { data: { order: null, accessCode: 'Y6GZQ6SUXF', reference: 'MG-NBAK33CK', unavailable: true } } as never }).body;
		const shown = text(html);
		expect(shown).toContain('No pudimos consultar el estado de tu compra ahora');
		expect(shown).toContain('MG-NBAK33CK');
		expect(shown).toContain('Si ya pagaste, no pagues de nuevo');
		expect(html).toContain('href="/checkout/resultado?ref=MG-NBAK33CK"');
		expect(shown).not.toContain('No encontramos');
	});

	it('keeps "No encontramos tu compra en este navegador" only when the browser has no order', () => {
		const shown = text(render(ResultPage, { props: { data: { order: null, accessCode: null } } as never }).body);
		expect(shown).toContain('No encontramos tu compra en este navegador');
	});

	it('a paid order offers no new purchase', () => {
		const shown = text(page('paid'));
		expect(shown).toContain('Tu compra está confirmada');
		expect(shown).not.toContain('Volver a la tienda');
		expect(shown).not.toContain('Si no llegaste a pagar');
	});
});
