import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';
import type { Product } from '#lib/server/types.js';
import ProductCard from './ProductCard.svelte';

// Owner feedback 2026-11-15d S1, S2: the shop marks its first card's add button as what the call to
// act brings on screen, and while the campaign gives chances a hand invites to tap it.

vi.mock('$app/forms', () => ({ enhance: () => ({ destroy() {} }) }));

const product = (variants: Product['variants']): Product => ({
	id: 'manual',
	slug: 'manual',
	name: 'Manual Taller Demo',
	description: 'Digital.',
	kind: 'digital',
	imageUrl: null,
	variants,
	upsells: []
});
const single = product([{ id: 'v1', name: 'Única', priceMinor: 500_000, currency: 'ARS', inStock: true, maxPerOrder: 5 }]);
const sizes = product([
	{ id: 'v1', name: 'M', priceMinor: 500_000, currency: 'ARS', inStock: true, maxPerOrder: 5 },
	{ id: 'v2', name: 'L', priceMinor: 500_000, currency: 'ARS', inStock: true, maxPerOrder: 5 }
]);
const soldOut = product([{ id: 'v1', name: 'Única', priceMinor: 500_000, currency: 'ARS', inStock: false, maxPerOrder: 5 }]);

const card = (props: Record<string, unknown>) => render(ProductCard, { props: props as never }).body;
/** The opening tag of the hand, when there is one. */
const hand = (html: string) => html.match(/<span[^>]*class="[^"]*add-nudge[^"]*"[^>]*>/)?.[0] ?? null;
const addButton = (html: string) => html.match(/<button[^>]*>Agregar al carrito<\/button>/)?.[0] ?? null;

describe('product card on the shop (2026-11-15d S1, S2)', () => {
	it('shows a hand, hidden from assistive technology, next to the add button when asked', () => {
		for (const item of [single, sizes]) {
			const html = card({ product: item, nudge: true });
			const tag = hand(html);
			expect(tag, item.variants.length > 1 ? 'with sizes' : 'single').not.toBeNull();
			expect(tag).toContain('aria-hidden="true"');
			// After the button, inside its form: it never comes before the button's text.
			expect(html.indexOf('add-nudge')).toBeGreaterThan(html.indexOf('Agregar al carrito'));
			expect(html.indexOf('add-nudge')).toBeLessThan(html.indexOf('</form>'));
		}
	});

	it('shows no hand by default nor without an add button', () => {
		expect(hand(card({ product: single }))).toBeNull();
		const html = card({ product: soldOut, nudge: true });
		expect(html).toContain('Sin stock');
		expect(hand(html)).toBeNull();
	});

	it('marks the add button the call to act brings on screen only when asked', () => {
		expect(addButton(card({ product: single, reveal: true }))).toContain('data-reveal');
		expect(addButton(card({ product: sizes, reveal: true }))).toContain('data-reveal');
		expect(card({ product: single })).not.toContain('data-reveal');
	});
});
