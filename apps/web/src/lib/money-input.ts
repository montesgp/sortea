import { MAX_EXPENSE_MINOR } from '@sortea/domain';

/**
 * Amounts typed in pesos as people write them in Argentina (odd/tasks/campaign-finance.md S2):
 * a dot groups thousands and a comma starts the centavos, so "12.500", "12500" and "12500,50"
 * are read, and an ambiguous "12.50" is refused instead of guessed. The amount becomes integer
 * minor units without floating point.
 */
export type MoneyInputResult = { ok: true; value: number } | { ok: false; message: string };

const FORMAT = 'Escribí el monto en pesos, por ejemplo 12.500 o 12500,50';
const PESOS = /^(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d{1,2}))?$/;

export function parseMoneyInput(text: string): MoneyInputResult {
	const value = text.trim().replace(/^\$\s*/, '');
	if (!value) return { ok: false, message: 'Indicá el monto del gasto' };
	const typed = PESOS.exec(value);
	if (!typed) return { ok: false, message: FORMAT };
	const minor = BigInt(typed[1]!.replaceAll('.', '')) * 100n + BigInt((typed[2] ?? '').padEnd(2, '0'));
	if (minor === 0n) return { ok: false, message: 'Indicá un monto mayor que cero' };
	if (minor > BigInt(MAX_EXPENSE_MINOR)) return { ok: false, message: 'El monto es demasiado grande' };
	return { ok: true, value: Number(minor) };
}

/** Minor units as the field shows them: 1250050 as "12.500,50", 1250000 as "12.500". */
export function moneyInputValue(minor: number): string {
	const pesos = String(Math.floor(minor / 100)).replace(/\B(?=(\d{3})+$)/g, '.');
	const cents = minor % 100;
	return cents ? `${pesos},${String(cents).padStart(2, '0')}` : pesos;
}
