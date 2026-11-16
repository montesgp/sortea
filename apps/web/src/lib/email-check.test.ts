import { describe, expect, it } from 'vitest';
import { emailCheck, emailSuggestion } from './email-check';

// S5 (feedback 2026-10-18): the checkout checks the email while it is typed, before the server
// answers. Checkout in two steps S5: one email field, and help at the moment for a mistyped domain.

describe('email check', () => {
	it('says nothing while the buyer types the address', () => {
		expect(emailCheck('ana@', false)).toBeUndefined();
	});

	it('flags a malformed address once the field was left, and clears it as soon as it is right', () => {
		expect(emailCheck('ana@', true)).toBe('Ingresá un email válido');
		expect(emailCheck('ana@mail.com', true)).toBeUndefined();
		expect(emailCheck('  ', true)).toBeUndefined();
	});
});

describe('email typo hint (S5)', () => {
	it('suggests the common domain the buyer most likely meant, keeping what is before the @', () => {
		expect(emailSuggestion('juana@gmial.com')).toBe('juana@gmail.com');
		expect(emailSuggestion('juana@gmail.con')).toBe('juana@gmail.com');
		expect(emailSuggestion('juana@gmail.co')).toBe('juana@gmail.com');
		expect(emailSuggestion('juana@gmail.com.ar')).toBe('juana@gmail.com');
		expect(emailSuggestion('juana@gmail')).toBe('juana@gmail.com');
		expect(emailSuggestion(' Juana.Perez@Hotmial.com ')).toBe('Juana.Perez@hotmail.com');
		expect(emailSuggestion('juana@hotmail.com.a')).toBe('juana@hotmail.com.ar');
		expect(emailSuggestion('juana@outlok.com')).toBe('juana@outlook.com');
		expect(emailSuggestion('juana@yaho.com.ar')).toBe('juana@yahoo.com.ar');
		expect(emailSuggestion('juana@live.co')).toBe('juana@live.com');
		expect(emailSuggestion('juana@iclod.com')).toBe('juana@icloud.com');
	});

	it('leaves correct, unknown and other real domains alone', () => {
		for (const email of ['juana@gmail.com', 'juana@hotmail.com.ar', 'juana@live.com.ar', 'juana@yahoo.com', 'juana@mail.com', 'juana@me.com', 'juana@yahoo.com.br', 'juana@hotmail.es', 'juana@tallerdemo.com.ar', 'juana@example.com']) {
			expect(emailSuggestion(email), email).toBeNull();
		}
	});

	it('gives nothing for a value that is not an address yet', () => {
		for (const email of ['', 'juana', 'juana@', '@gmial.com', 'juana@g']) expect(emailSuggestion(email), email).toBeNull();
	});
});
