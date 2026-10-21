import { describe, expect, it } from 'vitest';
import { cardChances, chancesExample, chancesExampleText, chancesText, poolWarning } from './chances';

describe('chances copy', () => {
	it('counts chances in es-AR', () => {
		expect(chancesText(1)).toBe('1 chance');
		expect(chancesText(6)).toBe('6 chances');
	});

	const chances = { campaign: { slug: 'moto', title: 'Moto 0 km' }, perUnit: { manual: 3, tapa: 3, remera: 1, buzo: 2 }, maxPerIdentity: null };

	it('shows on a card only what the locked rules grant for the product variants', () => {
		expect(cardChances(chances, ['manual'])).toEqual({ count: 3, upTo: false, campaign: 'Moto 0 km' });
		expect(cardChances(chances, ['sticker'])).toBeNull();
		expect(cardChances(chances, [])).toBeNull();
		expect(cardChances(null, ['manual'])).toBeNull();
	});

	// Owner feedback 2026-10-21: an option that grants none makes the card's number a maximum too.
	it('words equal chances plainly and different ones as a maximum, counting variants that grant none', () => {
		expect(cardChances(chances, ['manual', 'tapa'])).toEqual({ count: 3, upTo: false, campaign: 'Moto 0 km' });
		expect(cardChances(chances, ['manual', 'tapa', 'sticker'])).toEqual({ count: 3, upTo: true, campaign: 'Moto 0 km' });
		expect(cardChances(chances, ['remera', 'buzo', 'sticker'])).toEqual({ count: 2, upTo: true, campaign: 'Moto 0 km' });
		expect(cardChances(chances, ['remera'])).toEqual({ count: 1, upTo: false, campaign: 'Moto 0 km' });
	});
});

describe('coupon pool in the cart (ADR 0014 §1)', () => {
	const campaign = { slug: 'moto', title: 'Moto 0 km' };

	it('says nothing while the cart fits in what remains', () => {
		expect(poolWarning({ campaign, total: 3, remaining: 3 })).toBeNull();
		expect(poolWarning({ campaign, total: 0, remaining: 0 })).toBeNull();
	});

	it('warns before paying when the cart asks for more chances than remain', () => {
		expect(poolWarning({ campaign, total: 3, remaining: 2 })).toBe('Quedan 2 cupones para Moto 0 km y tu carrito suma 3 chances. Quitá algunos productos para continuar.');
		expect(poolWarning({ campaign, total: 2, remaining: 1 })).toBe('Queda 1 cupón para Moto 0 km y tu carrito suma 2 chances. Quitá algunos productos para continuar.');
		expect(poolWarning({ campaign, total: 1, remaining: 0 })).toBe('Se agotaron los cupones de Moto 0 km. Quitá los productos que dan chances para continuar.');
	});
});

describe('chances example for the campaign block (S4)', () => {
	const product = (id: string, name: string, kind: 'digital' | 'physical', variants: string[]) => ({ id, name, kind, variants: variants.map((variant) => ({ id: variant })) });
	const chances = { campaign: { slug: 'moto', title: 'Moto 0 km' }, perUnit: { manual: 3, tapa: 5, checklist: 5, remera: 9, poster: 2 }, maxPerIdentity: null };
	const catalog = [
		product('p-remera', 'Remera', 'physical', ['remera']),
		product('p-manual', 'Manual técnico', 'digital', ['manual', 'tapa']),
		product('p-checklist', 'Checklist de viaje', 'digital', ['checklist']),
		product('p-poster', 'Póster', 'digital', ['poster'])
	];

	it('picks the digital product whose variants grant the most chances, the first in catalog order on a tie', () => {
		expect(chancesExample(chances, catalog, 'moto')).toEqual({ product: 'Manual técnico', count: 5, upTo: true, campaign: 'Moto 0 km' });
		expect(chancesExample(chances, [catalog[2]!, catalog[1]!], 'moto')).toEqual({ product: 'Checklist de viaje', count: 5, upTo: false, campaign: 'Moto 0 km' });
	});

	it('words the example with the product, the chances and the campaign', () => {
		expect(chancesExampleText(chancesExample(chances, catalog, 'moto')!)).toBe('Ejemplo: comprando Manual técnico sumás hasta 5 chances para Moto 0 km');
		expect(chancesExampleText(chancesExample(chances, [catalog[2]!], 'moto')!)).toBe('Ejemplo: comprando Checklist de viaje sumás 5 chances para Moto 0 km');
	});

	it('shows nothing when no digital product grants chances, no campaign accepts participations or it is another campaign', () => {
		expect(chancesExample(chances, [catalog[0]!], 'moto')).toBeNull();
		expect(chancesExample(chances, [product('p-pdf', 'Guía', 'digital', ['guia'])], 'moto')).toBeNull();
		expect(chancesExample(chances, [], 'moto')).toBeNull();
		expect(chancesExample(null, catalog, 'moto')).toBeNull();
		expect(chancesExample(chances, catalog, 'otra')).toBeNull();
	});
});
