import { describe, expect, it } from 'vitest';
import { readWithdrawalRequest, withdrawalHref, withdrawalMessage } from './withdrawal';

// Owner feedback 2026-10-28 S12: the "Botón de arrepentimiento" opens WhatsApp with a prepared message.
describe('withdrawal request message', () => {
	it('names the order reference and the buyer', () => {
		expect(withdrawalMessage({ reference: 'MG-7K2Q9XHD', name: 'Ana Pérez' })).toBe(
			'Hola, quiero ejercer mi derecho de arrepentimiento. Pedido: MG-7K2Q9XHD. Nombre: Ana Pérez.'
		);
	});

	it('omits the parts the buyer left empty', () => {
		expect(withdrawalMessage({ reference: '', name: 'Ana Pérez' })).toBe('Hola, quiero ejercer mi derecho de arrepentimiento. Nombre: Ana Pérez.');
		expect(withdrawalMessage({ reference: 'MG-7K2Q9XHD', name: '' })).toBe('Hola, quiero ejercer mi derecho de arrepentimiento. Pedido: MG-7K2Q9XHD.');
		expect(withdrawalMessage({ reference: '', name: '' })).toBe('Hola, quiero ejercer mi derecho de arrepentimiento.');
	});
});

describe('withdrawal WhatsApp link', () => {
	it('opens a chat with the organization number and the encoded message', () => {
		expect(withdrawalHref('5492478407084', { reference: 'MG-7K2Q9XHD', name: 'Ana Pérez & Hijos' })).toBe(
			'https://wa.me/5492478407084?text=Hola%2C%20quiero%20ejercer%20mi%20derecho%20de%20arrepentimiento.%20Pedido%3A%20MG-7K2Q9XHD.%20Nombre%3A%20Ana%20P%C3%A9rez%20%26%20Hijos.'
		);
	});

	it('has no link when the organization has no valid number', () => {
		expect(withdrawalHref(undefined, { reference: '', name: '' })).toBeNull();
		expect(withdrawalHref('2478 40-7084', { reference: '', name: '' })).toBeNull();
	});
});

describe('reading the withdrawal form', () => {
	it('normalizes the receipt code to the format shown at the end of the purchase', () => {
		expect(readWithdrawalRequest({ reference: '  mg-7k2q 9xhd ', name: '  Ana   Pérez ' })).toEqual({
			ok: true,
			values: { reference: 'MG-7K2Q9XHD', name: 'Ana Pérez' }
		});
	});

	it('accepts an empty reference and name', () => {
		expect(readWithdrawalRequest({ reference: null, name: undefined })).toEqual({ ok: true, values: { reference: '', name: '' } });
	});

	it('refuses a reference that is not a receipt code, keeping what was typed', () => {
		for (const reference of ['7K2Q9XHD', 'MG-7K2Q9XH', 'MOTOG-7K2Q9XHD', 'MG_7K2Q9XHD', 'MG-7K2Q9XHDZ']) {
			expect(readWithdrawalRequest({ reference, name: 'Ana' }), reference).toEqual({
				ok: false,
				values: { reference: reference.toUpperCase(), name: 'Ana' },
				errors: { reference: 'Revisá el comprobante: tiene el formato XX-XXXXXXXX, como figura al terminar la compra. Si no lo tenés, dejalo vacío.' }
			});
		}
	});

	it('refuses a name longer than 120 characters', () => {
		const name = 'A'.repeat(121);
		expect(readWithdrawalRequest({ reference: '', name })).toEqual({
			ok: false,
			values: { reference: '', name },
			errors: { name: 'Escribí tu nombre en hasta 120 caracteres.' }
		});
		expect(readWithdrawalRequest({ reference: '', name: 'A'.repeat(120) }).ok).toBe(true);
	});
});
