import { describe, expect, it } from 'vitest';
import { balanceLines, pendingFeesNote, resultLabel, scopeHref } from './finance';

// odd/tasks/campaign-finance.md S1, S3, S5 (ADR 0025).

const balance = {
	salesMinor: 10_000_000,
	refundsMinor: 500_000,
	feesMinor: 400_000,
	feesPendingPayments: 2,
	prizesCommittedMinor: 3_000_000,
	prizesDeliveredMinor: 1_000_000,
	expensesByCategory: [
		{ category: 'tecnologia' as const, totalMinor: 250_000 },
		{ category: 'repuestos' as const, totalMinor: 1_200_000 }
	],
	expensesMinor: 1_450_000,
	resultMinor: 4_650_000,
	final: false
};

describe('scopeHref (S1)', () => {
	it('keeps the scope in the URL', () => {
		expect(scopeHref(null)).toBe('/admin');
		expect(scopeHref('0b9f6f1e-3c2a-4c1e-9d55-5d2b9e1a7c10')).toBe('/admin?campana=0b9f6f1e-3c2a-4c1e-9d55-5d2b9e1a7c10');
	});
});

describe('pendingFeesNote (S5)', () => {
	it('counts the payments Mercado Pago has not reported a fee for', () => {
		expect(pendingFeesNote(0)).toBeNull();
		expect(pendingFeesNote(1)).toBe('1 pago sin comisión informada');
		expect(pendingFeesNote(3)).toBe('3 pagos sin comisión informada');
	});
});

describe('balanceLines (S3, S5)', () => {
	it('lists sales, then every deduction with expenses by category, in that order', () => {
		const lines = balanceLines(balance);
		expect(lines.map((line) => [line.sign, line.label, line.amountMinor])).toEqual([
			['+', 'Ventas', 10_000_000],
			['−', 'Reintegros', 500_000],
			['−', 'Comisiones de Mercado Pago', 400_000],
			['−', 'Premios', 3_000_000],
			['−', 'Gastos', 1_450_000]
		]);
		expect(lines.find((line) => line.label === 'Comisiones de Mercado Pago')?.note).toBe('2 pagos sin comisión informada');
		expect(lines.find((line) => line.label === 'Premios')?.note).toBe('Comprometidos; entregados por $ 10.000');
		expect(lines.at(-1)?.detail).toEqual([
			{ label: 'Tecnología y hosting', amountMinor: 250_000 },
			{ label: 'Repuestos', amountMinor: 1_200_000 }
		]);
	});

	it('has no pending note when every fee was reported, and says when there are no expenses', () => {
		const lines = balanceLines({ ...balance, feesPendingPayments: 0, expensesByCategory: [], expensesMinor: 0 });
		expect(lines.find((line) => line.label === 'Comisiones de Mercado Pago')?.note).toBeNull();
		expect(lines.at(-1)).toMatchObject({ label: 'Gastos', amountMinor: 0, note: 'Sin gastos cargados', detail: [] });
	});
});

describe('resultLabel (S3)', () => {
	it('is a projection while the campaign sells and final once it stopped', () => {
		expect(resultLabel(false)).toBe('Resultado proyectado');
		expect(resultLabel(true)).toBe('Resultado final');
	});
});
