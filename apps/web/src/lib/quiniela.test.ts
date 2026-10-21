import { describe, expect, it } from 'vitest';
import { drawnAtFromInput, drawnAtLabel, extractOutcomeLabel, ordinal, parseExtracts } from './quiniela';

const twenty = Array.from({ length: 20 }, (_, index) => index * 37);

describe('parseExtracts (ADR 0014 §3)', () => {
	it('reads the 20 extracts pasted with spaces, commas, semicolons or new lines, keeping their order', () => {
		const pasted = `${twenty.slice(0, 5).join(' ')}\n${twenty.slice(5, 10).join(', ')}\r\n${twenty.slice(10, 15).join(';')}\t${twenty.slice(15).join('  ,  ')}`;
		expect(parseExtracts(pasted)).toEqual({ ok: true, extracts: twenty });
	});

	it('takes them as printed: zero-padded, with or without the position "1." prefix', () => {
		const printed = twenty.map((number, index) => `${index + 1}. ${String(number).padStart(4, '0')}`).join('\n');
		expect(parseExtracts(printed)).toEqual({ ok: true, extracts: twenty });
		expect(parseExtracts(['0000', ...twenty.slice(1).map(String)].join(' '))).toEqual({ ok: true, extracts: [0, ...twenty.slice(1)] });
	});

	it('asks for exactly 20', () => {
		expect(parseExtracts(twenty.slice(1).join(' '))).toEqual({ ok: false, message: 'Cargá los 20 extractos: hay 19' });
		expect(parseExtracts([...twenty, 5].join(' '))).toEqual({ ok: false, message: 'Cargá los 20 extractos: hay 21' });
		expect(parseExtracts('  ')).toEqual({ ok: false, message: 'Cargá los 20 extractos: hay 0' });
	});

	it('refuses anything that is not a number of up to 4 digits', () => {
		expect(parseExtracts([...twenty.slice(1), '12345'].join(' '))).toEqual({ ok: false, message: '"12345" no es un número de 4 cifras' });
		expect(parseExtracts([...twenty.slice(1), 'abc'].join(' '))).toEqual({ ok: false, message: '"abc" no es un número de 4 cifras' });
		expect(parseExtracts([...twenty.slice(1), '-1'].join(' '))).toEqual({ ok: false, message: '"-1" no es un número de 4 cifras' });
	});
});

describe('draw time (ADR 0014 §3)', () => {
	const timezone = 'America/Argentina/Buenos_Aires';

	it('reads the official date and time in the campaign time zone and sends it as UTC', () => {
		expect(drawnAtFromInput('2026-11-29', '21:00', timezone)).toBe('2026-11-30T00:00:00.000Z');
		expect(drawnAtFromInput('2026-11-29', '', timezone)).toBeNull();
		expect(drawnAtFromInput('', '21:00', timezone)).toBeNull();
	});

	it('shows it back as the campaign day and hour', () => {
		expect(drawnAtLabel('2026-11-30T00:00:00.000Z', timezone)).toBe('29/11/2026 a las 21:00');
	});
});

describe('copy', () => {
	it('names positions and outcomes in Spanish', () => {
		expect(ordinal(1)).toBe('1.º');
		expect(ordinal(20)).toBe('20.º');
		expect(extractOutcomeLabel.no_match).toBe('Sin coincidencia');
		expect(extractOutcomeLabel.repeated).toBe('Repetido, no cuenta');
		expect(extractOutcomeLabel.already_awarded).toBe('Ya figura en otro premio');
	});
});
