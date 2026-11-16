import { expenseCategoryLabels, type ExpenseCategory } from '@sortea/domain';
import { money } from './format.js';

/**
 * The overview of the organization or of one campaign, its expenses and its balance
 * (odd/tasks/campaign-finance.md S1, S2, S3, S5; ADR 0025).
 */
export interface CampaignBalance {
	salesMinor: number;
	refundsMinor: number;
	feesMinor: number;
	feesPendingPayments: number;
	prizesCommittedMinor: number;
	prizesDeliveredMinor: number;
	expensesByCategory: { category: ExpenseCategory; totalMinor: number }[];
	expensesMinor: number;
	resultMinor: number;
	/** The campaign stopped selling: the result is the recount, not a projection. */
	final: boolean;
}

export interface CampaignExpense {
	id: string;
	category: ExpenseCategory;
	detail: string;
	amountMinor: number;
	currency: string;
	/** The day it was spent, YYYY-MM-DD. */
	spentOn: string;
	createdAt: string;
	updatedAt: string;
}

/** The expense form as typed; sent back on a refusal so nothing typed is lost. */
export interface ExpenseInput {
	/** Empty for a new expense. */
	id: string;
	category: string;
	detail: string;
	amount: string;
	spentOn: string;
}

/** The overview of the scope: `/admin` for the organization, `?campana=<id>` for a campaign, so reload and back keep it. */
export function scopeHref(campaignId: string | null): string {
	return campaignId ? `/admin?campana=${campaignId}` : '/admin';
}

/** Payments Mercado Pago has not reported a fee for yet; their fee counts as zero until it does (S5). */
export function pendingFeesNote(payments: number): string | null {
	if (payments <= 0) return null;
	return payments === 1 ? '1 pago sin comisión informada' : `${payments} pagos sin comisión informada`;
}

export function resultLabel(final: boolean): string {
	return final ? 'Resultado final' : 'Resultado proyectado';
}

export interface BalanceLine {
	sign: '+' | '−';
	label: string;
	amountMinor: number;
	note: string | null;
	/** Expenses by category, in the order of the fixed list. */
	detail?: { label: string; amountMinor: number }[];
}

/** The balance as read top to bottom: sales, then every deduction (S5: sales − refunds − fees − prizes − expenses). */
export function balanceLines(balance: CampaignBalance, currency = 'ARS'): BalanceLine[] {
	return [
		{ sign: '+', label: 'Ventas', amountMinor: balance.salesMinor, note: null },
		{ sign: '−', label: 'Reintegros', amountMinor: balance.refundsMinor, note: null },
		{ sign: '−', label: 'Comisiones de Mercado Pago', amountMinor: balance.feesMinor, note: pendingFeesNote(balance.feesPendingPayments) },
		{ sign: '−', label: 'Premios', amountMinor: balance.prizesCommittedMinor, note: `Comprometidos; entregados por ${money(balance.prizesDeliveredMinor, currency)}` },
		{
			sign: '−',
			label: 'Gastos',
			amountMinor: balance.expensesMinor,
			note: balance.expensesByCategory.length ? null : 'Sin gastos cargados',
			detail: balance.expensesByCategory.map((row) => ({ label: expenseCategoryLabels[row.category], amountMinor: row.totalMinor }))
		}
	];
}
