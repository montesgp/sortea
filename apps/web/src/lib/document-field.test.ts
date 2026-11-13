import { documentTypes, normalizeDocument } from '@sortea/domain';
import { describe, expect, it } from 'vitest';
import { documentField, documentFields } from './document-field';

// Owner feedback 2026-11-12, S5: the document number shows, per type, an example of how to type it,
// the same in checkout and Consultar, and the example is what `normalizeDocument` accepts.

describe('document field per type (S5)', () => {
	it('covers every document type once, in the domain order', () => {
		expect(documentFields.map((field) => field.type)).toEqual([...documentTypes]);
	});

	it('each example is a valid document of its type, or a mask of its exact format', () => {
		for (const field of documentFields) {
			const example = field.placeholder.replace(/^Ej\.: /, '');
			// A real-looking CUIT would be someone's (and the public copy refuses valid CUITs): its example is a mask.
			if (example.includes('X')) expect(normalizeDocument(field.type, example.replace(/X/g, '0')), field.type).not.toMatchObject({ reason: 'invalid_format' });
			else expect(normalizeDocument(field.type, example), field.type).toMatchObject({ ok: true });
		}
	});

	it('says how to type each one, with a keyboard that fits', () => {
		expect(documentField('DNI')).toMatchObject({ label: 'DNI', placeholder: 'Ej.: 30123456', hint: '7 u 8 números, sin puntos.', inputmode: 'numeric' });
		expect(documentField('CUIT')).toMatchObject({ label: 'CUIT', placeholder: 'Ej.: 20XXXXXXXXX', hint: '11 números, sin guiones: prefijo, DNI y dígito verificador.', inputmode: 'numeric' });
		expect(documentField('PASSPORT')).toMatchObject({ label: 'Pasaporte', placeholder: 'Ej.: AAA123456', hint: 'Letras y números, sin espacios.', inputmode: 'text', autocapitalize: 'characters' });
	});

	it('an unknown type falls back to DNI', () => {
		expect(documentField('X').type).toBe('DNI');
		expect(documentField(undefined).type).toBe('DNI');
	});
});
