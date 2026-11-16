import { describe, expect, it } from 'vitest';
import { landingStep, stepFromState, stepOfField, stepOneErrors, stepState } from './checkout-steps';

// Checkout in two steps (S2, S4): step 1 is where the purchase is sent (email, nombre, apellido),
// step 2 the last details. Continuar checks step 1 in place; a refused submit opens the step that
// holds the first field to fix; Back and Forward move between the steps.

const ready = { email: 'juana@example.com', firstName: 'Juana', lastName: 'Pérez' };

describe('checkout steps', () => {
	it('puts email, nombre and apellido in step 1 and everything else in step 2', () => {
		expect(['email', 'firstName', 'lastName'].map(stepOfField)).toEqual([1, 1, 1]);
		expect(['documentType', 'documentNumber', 'phone', 'country', 'province', 'provinceOther', 'city', 'deliveryMethod', 'street', 'postalCode', 'terms', 'privacy', 'adultDeclaration'].map(stepOfField)).toEqual(Array(13).fill(2));
	});

	it('checks step 1 with the server rules and words, in the order of the fields', () => {
		expect(stepOneErrors(ready)).toEqual({});
		expect(stepOneErrors({ email: ' juana@example.com ', firstName: ' Juana ', lastName: 'P' })).toEqual({});
		const errors = stepOneErrors({ email: 'juana@', firstName: '  ', lastName: '' });
		expect(errors).toEqual({ email: 'Ingresá un email válido', firstName: 'Ingresá tu nombre', lastName: 'Ingresá tu apellido' });
		expect(Object.keys(errors)).toEqual(['email', 'firstName', 'lastName']);
		expect(stepOneErrors({})).toEqual({ email: 'Ingresá un email válido', firstName: 'Ingresá tu nombre', lastName: 'Ingresá tu apellido' });
		expect(stepOneErrors({ ...ready, firstName: 'x'.repeat(81) })).toEqual({ firstName: 'Ingresá tu nombre' });
	});

	it('opens a refused submit on the step that holds its first field error', () => {
		expect(landingStep({ errors: { email: 'Ingresá un email válido', phone: 'x' }, values: ready })).toBe(1);
		expect(landingStep({ errors: { terms: 'x', lastName: 'x' }, values: ready })).toBe(1);
		expect(landingStep({ errors: { phone: 'x', terms: 'x' }, values: ready })).toBe(2);
		// A refusal without field errors (the API said no): the pay button is in step 2.
		expect(landingStep({ errors: {}, refused: true, values: ready })).toBe(2);
		expect(landingStep({ errors: {}, refused: true, values: { ...ready, email: '' } })).toBe(1);
	});

	it('returns a restored draft to its step only when its step 1 is complete', () => {
		expect(landingStep({ errors: {}, draftStep: 2, values: ready })).toBe(2);
		expect(landingStep({ errors: {}, draftStep: 2, values: { ...ready, lastName: '' } })).toBe(1);
		expect(landingStep({ errors: {}, draftStep: 1, values: ready })).toBe(1);
		expect(landingStep({ errors: {}, values: {} })).toBe(1);
	});

	it('follows the history entry, and keeps the step while a legal text is open over the page', () => {
		expect(stepFromState(stepState(2), 1, 1)).toBe(2);
		expect(stepFromState(stepState(1), 2, 2)).toBe(1);
		// The entry the checkout opened on has no step: it is the landing step.
		expect(stepFromState({}, 2, 1)).toBe(2);
		expect(stepFromState({}, 1, 2)).toBe(1);
		expect(stepFromState({ legal: { title: 'Términos' } } as never, 1, 2)).toBe(2);
	});
});
