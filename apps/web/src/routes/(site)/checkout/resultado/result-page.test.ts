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
	items: [{ name: 'Calcomanía MotoGarage', quantity: 1, kind: 'physical', lineTotalMinor: 700_000 }],
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

	it('a paid order offers no new purchase', () => {
		const shown = text(page('paid'));
		expect(shown).toContain('Tu compra está confirmada');
		expect(shown).not.toContain('Volver a la tienda');
		expect(shown).not.toContain('Si no llegaste a pagar');
	});
});
