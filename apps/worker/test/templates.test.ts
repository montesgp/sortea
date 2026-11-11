import { describe, expect, it } from 'vitest';
import { orderPaidEmail, type PaidOrderView } from '../src/templates';

const brand = { name: 'Taller', accent: '#d32f2f', origin: 'https://taller.example' };

const order: PaidOrderView = {
	reference: 'TT-1',
	firstName: 'Juana',
	currency: 'ARS',
	totalMinor: 2_400_000,
	items: [{ name: 'Manual', quantity: 2, lineTotalMinor: 2_400_000 }],
	downloads: [],
	entries: [{ campaign: 'Moto 0 km', numbers: [7, 8], entryDigits: 4 }],
	deliveryMethod: 'digital',
	downloadHours: 72
};
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('paid order email', () => {
	it('calls participations chances, each one a numbered coupon (S5)', () => {
		const email = orderPaidEmail(brand, order);
		expect(email.html).toContain('Tus chances');
		expect(email.html).toContain('Cada chance es un cupón numerado');
		expect(email.html).toContain('Moto 0 km: 2 chances');
		// Coupons are zero-padded to the campaign digits (ADR 0014 §1).
		expect(email.html).toContain('<strong>N.º 0007</strong>, <strong>N.º 0008</strong>');
		expect(email.text).toContain('Tus chances para Moto 0 km (2): N.º 0007, N.º 0008');
		expect(email.html).not.toContain('participaciones');
		// Without a ticket the email carries nothing attached, as before (S9).
		expect(email.attachments ?? []).toEqual([]);
		expect(email.html).not.toContain('<img');
	});

	it('attaches the ticket, shows it above the list and keeps the list as the fallback (S9)', () => {
		const email = orderPaidEmail(brand, { ...order, entries: [{ ...order.entries[0]!, ticket: png }] });
		expect(email.attachments).toEqual([
			{ filename: 'chances-TT-1.png', contentType: 'image/png', content: png },
			{ filename: 'chances-TT-1.png', contentType: 'image/png', content: png, inlineId: 'ticket-TT-1-1@sortea' }
		]);
		expect(email.html).toContain('<img src="cid:ticket-TT-1-1@sortea" alt="Ticket con tus chances para Moto 0 km" width="504"');
		expect(email.html).toContain('Te adjuntamos este ticket como imagen (chances-TT-1.png): guardalo en tu teléfono.');
		expect(email.html.indexOf('cid:ticket-TT-1-1@sortea')).toBeLessThan(email.html.indexOf('Moto 0 km: 2 chances'));
		expect(email.html).toContain('<strong>N.º 0007</strong>, <strong>N.º 0008</strong>');
		expect(email.text).toContain('Te adjuntamos el ticket con tus chances (chances-TT-1.png): guardalo en tu teléfono.');
	});

	it('names one ticket per campaign when an order has several', () => {
		const email = orderPaidEmail(brand, {
			...order,
			entries: [
				{ campaign: 'Moto 0 km', numbers: [7], entryDigits: 4, ticket: png },
				{ campaign: 'Casco', numbers: [3], entryDigits: 3, ticket: png }
			]
		});
		expect(email.attachments?.map((attachment) => [attachment.filename, attachment.inlineId ?? null])).toEqual([
			['chances-TT-1-1.png', null],
			['chances-TT-1-1.png', 'ticket-TT-1-1@sortea'],
			['chances-TT-1-2.png', null],
			['chances-TT-1-2.png', 'ticket-TT-1-2@sortea']
		]);
		// The plain text says which campaign each ticket is for.
		expect(email.text).toContain('Te adjuntamos el ticket con tus chances para Moto 0 km (chances-TT-1-1.png): guardalo en tu teléfono.');
		expect(email.text).toContain('Te adjuntamos el ticket con tus chances para Casco (chances-TT-1-2.png): guardalo en tu teléfono.');
	});
});
