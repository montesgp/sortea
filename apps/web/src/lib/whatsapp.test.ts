import { describe, expect, it } from 'vitest';
import { WHATSAPP_GREETING, whatsappHref } from './whatsapp';

describe('WhatsApp contact link (S5)', () => {
	it('opens a chat with the organization number and a greeting', () => {
		expect(WHATSAPP_GREETING).toBe('Hola, vengo desde la web');
		expect(whatsappHref('5492478407084')).toBe('https://wa.me/5492478407084?text=Hola%2C%20vengo%20desde%20la%20web');
	});

	it('has no link when the organization has no valid number', () => {
		expect(whatsappHref(undefined)).toBeNull();
		expect(whatsappHref('')).toBeNull();
		expect(whatsappHref('2478 40-7084')).toBeNull();
	});
});
