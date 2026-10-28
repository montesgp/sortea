import { describe, expect, it } from 'vitest';
import { fieldMessage, type FieldFacts } from './field-validation';

// S8 (owner feedback 2026-10-28): a field the browser refuses shows a specific
// Spanish message under it instead of the generic English bubble.

const text = (facts: Partial<FieldFacts> = {}): FieldFacts => ({ type: 'text', length: 0, ...facts });

describe('field message', () => {
	it('names the empty field from its label', () => {
		expect(fieldMessage({ valueMissing: true }, text({ label: 'Email' }))).toBe('Completá el campo Email');
		expect(fieldMessage({ valueMissing: true }, text({ type: 'textarea', label: 'Descripción' }))).toBe('Completá el campo Descripción');
		expect(fieldMessage({ valueMissing: true }, text())).toBe('Completá este campo');
	});

	it('asks to tick an unchecked required checkbox', () => {
		expect(fieldMessage({ valueMissing: true }, text({ type: 'checkbox', label: 'Entiendo que se borran las credenciales' }))).toBe('Marcá esta casilla para continuar');
	});

	it('asks to choose in an unselected select or radio group', () => {
		expect(fieldMessage({ valueMissing: true }, text({ type: 'select-one', label: 'Provincia' }))).toBe('Elegí una opción en Provincia');
		expect(fieldMessage({ valueMissing: true }, text({ type: 'select-one' }))).toBe('Elegí una opción');
		expect(fieldMessage({ valueMissing: true }, text({ type: 'radio', label: 'Opción' }))).toBe('Elegí una opción en Opción');
		expect(fieldMessage({ valueMissing: true }, text({ type: 'file', label: 'Reporte' }))).toBe('Elegí un archivo');
	});

	it('flags a malformed email or web address', () => {
		expect(fieldMessage({ typeMismatch: true }, text({ type: 'email', label: 'Email', length: 3 }))).toBe('Ingresá un email válido');
		expect(fieldMessage({ typeMismatch: true }, text({ type: 'url', length: 3 }))).toBe('Ingresá una dirección web válida, por ejemplo https://ejemplo.com');
	});

	it('explains a pattern with the field title, then its hint, then its label', () => {
		expect(fieldMessage({ patternMismatch: true }, text({ title: 'Seis números', hint: 'Otro', length: 2 }))).toBe('Seis números');
		expect(fieldMessage({ patternMismatch: true }, text({ hint: 'Minúsculas, números y guiones.', length: 2 }))).toBe('Revisá el formato: Minúsculas, números y guiones.');
		expect(fieldMessage({ patternMismatch: true }, text({ label: 'Código de 6 dígitos', length: 2 }))).toBe('Revisá el formato del campo Código de 6 dígitos');
		expect(fieldMessage({ patternMismatch: true }, text({ length: 2 }))).toBe('Revisá el formato de este dato');
	});

	it('gives the length limits with the current count', () => {
		expect(fieldMessage({ tooShort: true }, text({ minLength: 10, length: 4 }))).toBe('Escribí al menos 10 caracteres (ahora hay 4)');
		expect(fieldMessage({ tooShort: true }, text({ minLength: 2, length: 1 }))).toBe('Escribí al menos 2 caracteres (ahora hay 1)');
		expect(fieldMessage({ tooLong: true }, text({ maxLength: 4, length: 5 }))).toBe('Escribí como máximo 4 caracteres (ahora hay 5)');
	});

	it('gives the range of a number', () => {
		expect(fieldMessage({ rangeUnderflow: true }, text({ type: 'number', min: '1', length: 1 }))).toBe('Ingresá un número mayor o igual a 1');
		expect(fieldMessage({ rangeOverflow: true }, text({ type: 'number', max: '100', length: 3 }))).toBe('Ingresá un número menor o igual a 100');
		expect(fieldMessage({ stepMismatch: true }, text({ type: 'number', step: '1', length: 3 }))).toBe('Ingresá un número entero');
		expect(fieldMessage({ stepMismatch: true }, text({ type: 'number', step: '5', length: 1 }))).toBe('Ingresá un múltiplo de 5');
		expect(fieldMessage({ badInput: true }, text({ type: 'number', length: 0 }))).toBe('Ingresá un número');
	});

	it('gives the range of a date or time', () => {
		expect(fieldMessage({ rangeUnderflow: true }, text({ type: 'date', min: '2026-11-01', length: 10 }))).toBe('Elegí una fecha desde el 01/11/2026');
		expect(fieldMessage({ rangeOverflow: true }, text({ type: 'date', max: '2026-12-31', length: 10 }))).toBe('Elegí una fecha hasta el 31/12/2026');
		expect(fieldMessage({ badInput: true }, text({ type: 'datetime-local' }))).toBe('Completá la fecha y la hora');
		expect(fieldMessage({ badInput: true }, text({ type: 'date' }))).toBe('Ingresá una fecha completa');
	});

	it('keeps a message the page set itself, and has a Spanish fallback', () => {
		expect(fieldMessage({ customError: true }, text({ custom: 'Elegí otra fecha' }))).toBe('Elegí otra fecha');
		expect(fieldMessage({}, text())).toBe('Revisá este dato');
	});

	it('reports a missing value before any other problem', () => {
		expect(fieldMessage({ valueMissing: true, customError: true }, text({ label: 'Nombre', custom: 'Otro' }))).toBe('Completá el campo Nombre');
	});
});
