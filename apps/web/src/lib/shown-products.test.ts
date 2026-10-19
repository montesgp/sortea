import { describe, expect, it } from 'vitest';
import { shownProducts } from './shown-products';

// S2, S3 (feedback 2026-10-18b): the campaign page and the home show the
// products chosen in the back office, or every active product when none is.

const catalog = [{ id: 'manual' }, { id: 'checklist' }, { id: 'sticker' }, { id: 'shirt' }];

describe('shown products', () => {
	it('shows the whole catalog, in its order, when nothing is chosen', () => {
		expect(shownProducts(catalog, [])).toEqual(catalog);
		expect(shownProducts(catalog, undefined)).toEqual(catalog);
	});

	it('shows only the chosen ones, in catalog order', () => {
		expect(shownProducts(catalog, ['shirt', 'manual'])).toEqual([{ id: 'manual' }, { id: 'shirt' }]);
	});

	it('ignores a chosen product that is no longer for sale, and falls back to all when none is left', () => {
		expect(shownProducts(catalog, ['shirt', 'gone'])).toEqual([{ id: 'shirt' }]);
		expect(shownProducts(catalog, ['gone'])).toEqual(catalog);
	});
});
