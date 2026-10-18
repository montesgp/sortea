import { describe, expect, it } from 'vitest';
import { emailCheck } from './email-check';

// S5 (feedback 2026-10-18): the checkout checks the email while it is typed and
// as soon as both fields are filled, not only when the server answers.

const untouched = { email: false, confirm: false };

describe('email check', () => {
	it('says nothing while the buyer types the first address', () => {
		expect(emailCheck('ana@', '', untouched)).toEqual({});
	});

	it('flags a malformed address once the field was left, and clears it as soon as it is right', () => {
		expect(emailCheck('ana@', '', { email: true, confirm: false })).toEqual({ email: 'Ingresá un email válido' });
		expect(emailCheck('ana@mail.com', '', { email: true, confirm: false })).toEqual({});
	});

	it('compares both as soon as both are filled, while the confirmation is typed', () => {
		expect(emailCheck('ana@mail.com', 'ana@', untouched)).toEqual({});
		expect(emailCheck('ana@mail.com', 'ana@mail.co', untouched)).toEqual({});
		expect(emailCheck('ana@mail.com', 'ana@mail.cop', untouched)).toEqual({ emailConfirm: 'Los emails no coinciden' });
		expect(emailCheck('ana@mail.com', 'ana@mail.co', { email: false, confirm: true })).toEqual({ emailConfirm: 'Los emails no coinciden' });
		expect(emailCheck('ana@mail.com', ' Ana@Mail.com ', untouched)).toEqual({ matches: true });
	});

	it('does not confirm a match of a malformed address', () => {
		expect(emailCheck('ana@', 'ana@', { email: true, confirm: true })).toEqual({ email: 'Ingresá un email válido' });
	});
});
