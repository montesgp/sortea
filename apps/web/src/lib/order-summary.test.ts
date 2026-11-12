import { describe, expect, it } from 'vitest';
import { STATUS_POLL } from './order-status';
import { copyText, orderSummaryText } from './order-summary';

// Owner feedback 2026-11-11b, S1 (L2): "Copiar resumen" puts the purchase in plain text the buyer
// can paste in WhatsApp: site, order, date, products, total, campaign and coupons.

const summary = {
	site: 'Taller Demo',
	reference: 'TD-NBAK33CK',
	createdAt: '2026-11-11T19:07:00Z',
	timezone: 'America/Argentina/Buenos_Aires',
	currency: 'ARS',
	totalMinor: 2_000_000,
	items: [
		{ name: 'Calcomanía Taller Demo', quantity: 2 },
		{ name: 'Manual técnico', quantity: 1 }
	],
	coupons: { campaign: 'Moto 0 km', entryDigits: 4, numbers: [7, 8] }
};

describe('order summary text (S1)', () => {
	it('lists site, order, date, each product with its quantity, total, campaign and coupons', () => {
		expect(orderSummaryText(summary)).toBe(
			[
				'Taller Demo',
				'Compra TD-NBAK33CK',
				'Fecha: 11 de noviembre de 2026 a las 16:07',
				'Calcomanía Taller Demo × 2',
				'Manual técnico × 1',
				'Total: $ 20.000',
				'Tus chances para Moto 0 km (2): N.º 0007, N.º 0008'
			].join('\n')
		);
	});

	it('a purchase without chances has no coupon line', () => {
		const text = orderSummaryText({ ...summary, coupons: null });
		expect(text).not.toContain('chances');
		expect(text.split('\n').at(-1)).toBe('Total: $ 20.000');
	});
});

describe('copying the summary', () => {
	it('says it copied when the clipboard takes the text', async () => {
		const written: string[] = [];
		const clipboard = { writeText: async (text: string) => void written.push(text) };
		expect(await copyText('resumen', clipboard)).toBe('copied');
		expect(written).toEqual(['resumen']);
	});

	it('falls back to selectable text without a clipboard or when it refuses', async () => {
		expect(await copyText('resumen', undefined)).toBe('fallback');
		expect(await copyText('resumen', { writeText: () => Promise.reject(new Error('NotAllowedError')) })).toBe('fallback');
	});
});

describe('result page polling (S7)', () => {
	// `/checkout/orders/status` allows 30 requests in 5 minutes per client (apps/api/src/modules/checkout.ts).
	// Polling past it turned a pending order into "No encontramos tu compra en este navegador".
	it('the first load and every refresh stay within the status rate limit', () => {
		expect(STATUS_POLL.rounds + 1).toBeLessThanOrEqual(30);
		expect(STATUS_POLL.rounds * STATUS_POLL.intervalMs).toBeGreaterThanOrEqual(120_000);
	});
});
