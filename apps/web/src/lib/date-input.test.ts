import { describe, expect, it } from 'vitest';
import { dateFieldValue, dateTimeFieldValue, parseDateInput, parseDateTimeInput, parseTimeInput, readDateTimeField } from './date-input';
import { fromLocalInput } from './tz';

const timezone = 'America/Argentina/Buenos_Aires';

describe('parseDateInput (draw room S1)', () => {
	it('reads dd/mm/aaaa as the YYYY-MM-DD day', () => {
		expect(parseDateInput('25/12/2026')).toEqual({ ok: true, value: '2026-12-25' });
		expect(parseDateInput(' 5/3/2026 ')).toEqual({ ok: true, value: '2026-03-05' });
		expect(parseDateInput('29/02/2028')).toEqual({ ok: true, value: '2028-02-29' });
	});

	it('takes a YYYY-MM-DD day as it is, for links written before dd/mm/aaaa', () => {
		expect(parseDateInput('2026-11-01')).toEqual({ ok: true, value: '2026-11-01' });
	});

	it('leaves an empty field empty', () => {
		expect(parseDateInput('')).toEqual({ ok: true, value: null });
		expect(parseDateInput('   ')).toEqual({ ok: true, value: null });
	});

	it('refuses days that do not exist', () => {
		expect(parseDateInput('31/02/2027')).toEqual({ ok: false, message: 'La fecha 31/02/2027 no existe' });
		expect(parseDateInput('29/02/2027')).toEqual({ ok: false, message: 'La fecha 29/02/2027 no existe' });
		expect(parseDateInput('01/13/2027')).toEqual({ ok: false, message: 'La fecha 01/13/2027 no existe' });
		expect(parseDateInput('00/01/2027')).toEqual({ ok: false, message: 'La fecha 00/01/2027 no existe' });
		expect(parseDateInput('2027-02-31')).toEqual({ ok: false, message: 'La fecha 2027-02-31 no existe' });
	});

	it('refuses other shapes', () => {
		for (const value of ['25/12/26', '12-25-2026x', 'mañana', '25.12', '2026/12/25']) {
			expect(parseDateInput(value)).toEqual({ ok: false, message: 'Escribí la fecha como dd/mm/aaaa, por ejemplo 25/12/2026' });
		}
	});
});

describe('parseTimeInput', () => {
	it('reads hh:mm on a 24-hour clock', () => {
		expect(parseTimeInput('21:00')).toEqual({ ok: true, value: '21:00' });
		expect(parseTimeInput('9:05')).toEqual({ ok: true, value: '09:05' });
		expect(parseTimeInput('00:00')).toEqual({ ok: true, value: '00:00' });
		expect(parseTimeInput('23:59')).toEqual({ ok: true, value: '23:59' });
		expect(parseTimeInput('')).toEqual({ ok: true, value: null });
	});

	it('refuses hours past 23:59 and other shapes', () => {
		for (const value of ['24:00', '23:60', '9 pm', '2100', '21:0']) {
			expect(parseTimeInput(value)).toEqual({ ok: false, message: 'Escribí la hora como hh:mm, de 00:00 a 23:59' });
		}
	});
});

describe('parseDateTimeInput', () => {
	it('joins the day and the time as the local value the forms sent before', () => {
		expect(parseDateTimeInput('25/12/2026', '21:00')).toEqual({ ok: true, value: '2026-12-25T21:00' });
		expect(parseDateTimeInput('', '')).toEqual({ ok: true, value: null });
	});

	it('asks for the missing half', () => {
		expect(parseDateTimeInput('25/12/2026', '')).toEqual({ ok: false, message: 'Falta la hora (hh:mm)' });
		expect(parseDateTimeInput('', '21:00')).toEqual({ ok: false, message: 'Falta la fecha (dd/mm/aaaa)' });
	});

	it('passes on the error of either half', () => {
		expect(parseDateTimeInput('31/02/2027', '21:00')).toEqual({ ok: false, message: 'La fecha 31/02/2027 no existe' });
		expect(parseDateTimeInput('25/12/2026', '24:00')).toEqual({ ok: false, message: 'Escribí la hora como hh:mm, de 00:00 a 23:59' });
	});
});

describe('readDateTimeField', () => {
	const form = (entries: Record<string, string>) => {
		const data = new FormData();
		for (const [key, value] of Object.entries(entries)) data.set(key, value);
		return data;
	};

	it('turns the typed day and time into the same UTC instant as the old datetime-local field', () => {
		expect(readDateTimeField(form({ drawAt: '25/12/2026', drawAtTime: '21:00' }), 'drawAt', timezone)).toEqual({ ok: true, value: fromLocalInput('2026-12-25T21:00', timezone) });
		expect(readDateTimeField(form({ drawAt: '25/12/2026', drawAtTime: '21:00' }), 'drawAt', timezone)).toEqual({ ok: true, value: '2026-12-26T00:00:00.000Z' });
	});

	it('is empty when both halves are, and says what is wrong otherwise', () => {
		expect(readDateTimeField(form({}), 'drawAt', timezone)).toEqual({ ok: true, value: null });
		expect(readDateTimeField(form({ drawAt: '31/02/2027', drawAtTime: '10:00' }), 'drawAt', timezone)).toEqual({ ok: false, message: 'La fecha 31/02/2027 no existe' });
	});
});

describe('field values', () => {
	it('writes a YYYY-MM-DD day back as dd/mm/aaaa, and leaves typed text as it was', () => {
		expect(dateFieldValue('2026-12-25')).toBe('25/12/2026');
		expect(dateFieldValue('')).toBe('');
		expect(dateFieldValue(undefined)).toBe('');
		expect(dateFieldValue('31/02/2027')).toBe('31/02/2027');
	});

	it('splits an instant into the local day and time of the time zone', () => {
		expect(dateTimeFieldValue('2026-12-26T00:00:00.000Z', timezone)).toEqual({ date: '25/12/2026', time: '21:00' });
		expect(dateTimeFieldValue('2026-12-01T03:00:00.000Z', timezone)).toEqual({ date: '01/12/2026', time: '00:00' });
		expect(dateTimeFieldValue(null, timezone)).toEqual({ date: '', time: '' });
	});
});
