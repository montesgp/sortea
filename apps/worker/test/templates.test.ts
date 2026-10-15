import { describe, expect, it } from 'vitest';
import { orderPaidEmail } from '../src/templates';

const brand = { name: 'Taller', accent: '#d32f2f', origin: 'https://taller.example' };

describe('paid order email', () => {
	it('calls participations chances, each one a numbered coupon (S5)', () => {
		const email = orderPaidEmail(brand, {
			reference: 'TT-1',
			firstName: 'Juana',
			currency: 'ARS',
			totalMinor: 2_400_000,
			items: [{ name: 'Manual', quantity: 2, lineTotalMinor: 2_400_000 }],
			downloads: [],
			entries: [{ campaign: 'Moto 0 km', numbers: [7, 8] }],
			deliveryMethod: 'digital',
			downloadHours: 72
		});
		expect(email.html).toContain('Tus chances');
		expect(email.html).toContain('Cada chance es un cupón numerado');
		expect(email.html).toContain('Moto 0 km: 2 chances');
		expect(email.text).toContain('Tus chances para Moto 0 km (2): #7, #8');
		expect(email.html).not.toContain('participaciones');
	});
});
