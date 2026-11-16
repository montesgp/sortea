import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { balanceIsFinal, campaignResult, expenseCategories, expenseCategoryLabels, expenseInputSchema, expensePatchSchema, MAX_EXPENSE_MINOR, prizesCount } from '../src';

/** odd/tasks/campaign-finance.md S2, S4, S5: expenses charged to a campaign and the campaign result. */
const valid = { category: 'repuestos', detail: '  Carburador y bujías  ', amountMinor: 4_500_000, spentOn: '2026-11-02' };

function fieldErrors(value: unknown, schema: z.ZodType = expenseInputSchema) {
	const result = schema.safeParse(value);
	expect(result.success).toBe(false);
	const errors: Record<string, string[]> = {};
	for (const issue of result.error!.issues) (errors[issue.path.join('.') || '_'] ??= []).push(issue.message);
	return errors;
}

describe('expense categories (S4)', () => {
	it('are the fixed list, in order, with their Spanish labels', () => {
		expect(expenseCategories).toEqual(['tecnologia', 'dominio', 'repuestos', 'mano_de_obra', 'combustible', 'publicidad', 'comisiones', 'otros']);
		expect(expenseCategoryLabels).toEqual({
			tecnologia: 'Tecnología y hosting',
			dominio: 'Dominio',
			repuestos: 'Repuestos',
			mano_de_obra: 'Mano de obra',
			combustible: 'Combustible y traslados',
			publicidad: 'Publicidad',
			comisiones: 'Comisiones y bancos',
			otros: 'Otros'
		});
	});
});

describe('expense input (S2)', () => {
	it('accepts a category, a trimmed detail, an amount in minor units and a calendar day', () => {
		expect(expenseInputSchema.parse(valid)).toEqual({ category: 'repuestos', detail: 'Carburador y bujías', amountMinor: 4_500_000, spentOn: '2026-11-02' });
		expect(expenseInputSchema.parse({ ...valid, amountMinor: MAX_EXPENSE_MINOR, detail: 'x'.repeat(200) }).amountMinor).toBe(MAX_EXPENSE_MINOR);
		expect(expenseInputSchema.parse({ ...valid, amountMinor: 1 }).amountMinor).toBe(1);
	});

	it('refuses a category outside the list', () => {
		expect(fieldErrors({ ...valid, category: 'viaticos' })).toEqual({ category: ['Elegí una categoría de la lista'] });
	});

	it('refuses an empty or too long detail', () => {
		expect(fieldErrors({ ...valid, detail: '   ' })).toEqual({ detail: ['Describí el gasto'] });
		expect(fieldErrors({ ...valid, detail: 'x'.repeat(201) })).toEqual({ detail: ['El detalle admite hasta 200 caracteres'] });
	});

	it('refuses zero, negative, fractional, missing and absurd amounts', () => {
		for (const amountMinor of [0, -100, 10.5, '4500', undefined]) {
			expect(fieldErrors({ ...valid, amountMinor }), String(amountMinor)).toEqual({ amountMinor: ['Indicá un importe mayor que cero, en centavos'] });
		}
		expect(fieldErrors({ ...valid, amountMinor: MAX_EXPENSE_MINOR + 1 })).toEqual({ amountMinor: ['El importe es demasiado grande'] });
	});

	it('refuses a day that is not YYYY-MM-DD or does not exist', () => {
		for (const spentOn of ['02/11/2026', '2026-02-30', '2026-11-2', '', undefined]) {
			expect(fieldErrors({ ...valid, spentOn }), String(spentOn)).toEqual({ spentOn: ['Indicá la fecha del gasto (AAAA-MM-DD)'] });
		}
	});

	it('edits any subset of the fields, but at least one', () => {
		expect(expensePatchSchema.parse({ amountMinor: 100 })).toEqual({ amountMinor: 100 });
		expect(expensePatchSchema.parse({ detail: ' Nafta ' })).toEqual({ detail: 'Nafta' });
		expect(fieldErrors({}, expensePatchSchema)).toEqual({ _: ['Indicá qué cambiar del gasto'] });
		expect(fieldErrors({ category: 'x' }, expensePatchSchema)).toEqual({ category: ['Elegí una categoría de la lista'] });
	});
});

describe('campaign result (S5)', () => {
	it('is sales minus refunds, fees, prizes and expenses', () => {
		expect(campaignResult({ salesMinor: 10_000, refundsMinor: 1_000, feesMinor: 629, prizesMinor: 5_000, expensesMinor: 2_000 })).toBe(1_371);
		// A sale refunded in full nets zero: sales count every charged order, refunds take it back once.
		expect(campaignResult({ salesMinor: 100, refundsMinor: 100, feesMinor: 0, prizesMinor: 0, expensesMinor: 0 })).toBe(0);
	});

	it('counts prizes once the campaign opened, and an archived one only if it published its manifest', () => {
		for (const status of ['open', 'closed', 'awarding', 'fulfilled'] as const) expect(prizesCount(status, false), status).toBe(true);
		for (const status of ['draft', 'review', 'published'] as const) expect(prizesCount(status, true), status).toBe(false);
		expect(prizesCount('archived', true)).toBe(true);
		expect(prizesCount('archived', false)).toBe(false);
	});

	it('is final once the campaign closed', () => {
		for (const status of ['closed', 'awarding', 'fulfilled', 'archived'] as const) expect(balanceIsFinal(status), status).toBe(true);
		for (const status of ['draft', 'review', 'published', 'open'] as const) expect(balanceIsFinal(status), status).toBe(false);
	});
});
