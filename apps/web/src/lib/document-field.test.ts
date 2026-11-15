import { documentTypes, normalizeDocument } from '@sortea/domain';
import { describe, expect, it } from 'vitest';
import { documentChecks, documentField, documentFields } from './document-field';

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

// Owner feedback 2026-11-15 S8: instead of a paragraph on how the number is made, checkout lists the
// requirements of the type and ticks each one green while it is typed, like a password rule list.
describe('document requirements ticked while typed (S8)', () => {
	// Built here, never written down: a valid CUIT literal would be someone's.
	const cuit = (body: string) => {
		const weights = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
		const remainder = 11 - (weights.reduce((sum, weight, index) => sum + weight * Number(body[index]), 0) % 11);
		return body + (remainder === 11 ? 0 : remainder === 10 ? 9 : remainder);
	};
	const view = (type: string, raw: string) => {
		const result = documentChecks(type, raw);
		return { valid: result.valid, checks: result.checks.map((check) => `${check.ok ? '✓' : '·'} ${check.label}`) };
	};

	it('DNI: 7 or 8 numbers, dots and spaces allowed', () => {
		expect(view('DNI', '')).toEqual({ valid: false, checks: ['· 7 u 8 números'] });
		expect(view('DNI', '301234')).toEqual({ valid: false, checks: ['· 7 u 8 números'] });
		expect(view('DNI', '30.123.456')).toEqual({ valid: true, checks: ['✓ 7 u 8 números'] });
		expect(view('DNI', '301234567').valid).toBe(false);
	});

	it('CUIT: 11 numbers and a check digit that matches', () => {
		const good = cuit('2012345678');
		const bad = good.slice(0, 10) + ((Number(good[10]) + 1) % 10);
		expect(view('CUIT', '2012345')).toEqual({ valid: false, checks: ['· 11 números', '· Dígito verificador correcto'] });
		expect(view('CUIT', bad)).toEqual({ valid: false, checks: ['✓ 11 números', '· Dígito verificador correcto'] });
		expect(view('CUIT', `${good.slice(0, 2)}-${good.slice(2, 10)}-${good.slice(10)}`)).toEqual({ valid: true, checks: ['✓ 11 números', '✓ Dígito verificador correcto'] });
	});

	it('passport: 6 to 12 letters or numbers', () => {
		expect(view('PASSPORT', 'aa1')).toEqual({ valid: false, checks: ['· De 6 a 12 letras o números'] });
		expect(view('PASSPORT', 'aaa123456')).toEqual({ valid: true, checks: ['✓ De 6 a 12 letras o números'] });
	});

	it('ticks all of them exactly when the server accepts the number', () => {
		for (const [type, raw] of [['DNI', '1234567'], ['DNI', '12 345'], ['CUIT', cuit('2712345678')], ['CUIT', '20000000000'], ['PASSPORT', 'AB-123456'], ['PASSPORT', 'ABC1234567890']] as const) {
			const result = documentChecks(type, raw);
			expect(result.valid, `${type} ${raw}`).toBe(normalizeDocument(type, raw).ok);
			expect(result.checks.every((check) => check.ok), `${type} ${raw}`).toBe(result.valid);
		}
	});
});
