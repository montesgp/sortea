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
	// Owner feedback 2026-11-11b, S2: no ZIP to open on the phone; each file has its own button.
	it('gives each file its own button and plain-text line, named after the file', () => {
		const email = orderPaidEmail(brand, {
			...order,
			downloads: [
				{ filename: 'TallerDemo-calcomania.png', url: 'https://taller.example/descargas/aaaaaaaaaaaaaaaaaaaaaa' },
				{ filename: 'TallerDemo-fondo-celular.png', url: 'https://taller.example/descargas/bbbbbbbbbbbbbbbbbbbbbb' }
			]
		});
		expect(email.html).toContain('Tus archivos');
		expect(email.html).toContain('Descargar TallerDemo-calcomania.png');
		expect(email.html).toContain('href="https://taller.example/descargas/bbbbbbbbbbbbbbbbbbbbbb"');
		expect(email.html.indexOf('Descargar TallerDemo-calcomania.png')).toBeLessThan(email.html.indexOf('Descargar TallerDemo-fondo-celular.png'));
		expect(email.text).toContain('Descargar TallerDemo-calcomania.png: https://taller.example/descargas/aaaaaaaaaaaaaaaaaaaaaa');
		expect(email.text).toContain('Descargar TallerDemo-fondo-celular.png: https://taller.example/descargas/bbbbbbbbbbbbbbbbbbbbbb');
	});

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

	// Owner feedback 2026-11-15 S6: one ticket shows once; it was sent inline and again as a download (S9),
	// so mail viewers showed the same picture twice. The inline image is the one to save.
	it('sends each ticket once, as the image shown above the list, and keeps the list as the fallback', () => {
		const email = orderPaidEmail(brand, { ...order, entries: [{ ...order.entries[0]!, ticket: png }] });
		expect(email.attachments).toEqual([{ filename: 'chances-TT-1.png', contentType: 'image/png', content: png, inlineId: 'ticket-TT-1-1@sortea' }]);
		expect(email.html).toContain('<img src="cid:ticket-TT-1-1@sortea" alt="Ticket con tus chances para Moto 0 km" width="504"');
		expect(email.html).toContain('Guardá esta imagen en tu teléfono: es tu ticket.');
		expect(email.html).not.toContain('Te adjuntamos');
		expect(email.html.indexOf('cid:ticket-TT-1-1@sortea')).toBeLessThan(email.html.indexOf('Moto 0 km: 2 chances'));
		expect(email.html).toContain('<strong>N.º 0007</strong>, <strong>N.º 0008</strong>');
		expect(email.text).not.toContain('adjuntamos');
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
			['chances-TT-1-1.png', 'ticket-TT-1-1@sortea'],
			['chances-TT-1-2.png', 'ticket-TT-1-2@sortea']
		]);
		// Each image names the campaign it is for.
		expect(email.html).toContain('alt="Ticket con tus chances para Moto 0 km"');
		expect(email.html).toContain('alt="Ticket con tus chances para Casco"');
	});
});

// Owner feedback 2026-11-15 S7: the organization's logo heads every email; without one, its name.
describe('email header', () => {
	const header = (html: string) => html.slice(html.indexOf('<tr><td style="background:#141414'), html.indexOf('</td></tr>', html.indexOf('<tr><td style="background:#141414')));

	it('shows the published logo, named after the organization', () => {
		const email = orderPaidEmail({ ...brand, logoUrl: 'https://taller.example/tenants/taller/logo.png' }, order);
		expect(header(email.html)).toContain('<img src="https://taller.example/tenants/taller/logo.png" alt="Taller" height="56"');
		expect(header(email.html)).not.toMatch(/>Taller$/);
	});

	it('keeps the name without a logo', () => {
		expect(header(orderPaidEmail(brand, order).html)).toMatch(/>Taller$/);
		expect(header(orderPaidEmail({ ...brand, logoUrl: null }, order).html)).not.toContain('<img');
	});
});
