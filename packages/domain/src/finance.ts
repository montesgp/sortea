import { z } from 'zod';
import type { CampaignStatus } from './campaign';
import { isCalendarDate } from './dates';

/**
 * Campaign finance (odd/tasks/campaign-finance.md, ADR 0025). Every expense belongs to one
 * campaign and is charged against its result; the organization view adds every campaign's.
 * Categories are a fixed list plus a free detail, so the balance can group them (S4).
 */
export const expenseCategories = ['tecnologia', 'dominio', 'repuestos', 'mano_de_obra', 'combustible', 'publicidad', 'comisiones', 'otros'] as const;
export type ExpenseCategory = (typeof expenseCategories)[number];

export const expenseCategoryLabels: Record<ExpenseCategory, string> = {
	tecnologia: 'Tecnología y hosting',
	dominio: 'Dominio',
	repuestos: 'Repuestos',
	mano_de_obra: 'Mano de obra',
	combustible: 'Combustible y traslados',
	publicidad: 'Publicidad',
	comisiones: 'Comisiones y bancos',
	otros: 'Otros'
};

/** Ten thousand million pesos in centavos: far above any real expense, far below a safe integer. */
export const MAX_EXPENSE_MINOR = 1_000_000_000_000;

const amountMessage = 'Indicá un importe mayor que cero, en centavos';
const dayMessage = 'Indicá la fecha del gasto (AAAA-MM-DD)';

const expenseFields = {
	category: z.enum(expenseCategories, { error: 'Elegí una categoría de la lista' }),
	detail: z.string({ error: 'Describí el gasto' }).trim().min(1, 'Describí el gasto').max(200, 'El detalle admite hasta 200 caracteres'),
	amountMinor: z.number({ error: amountMessage }).int(amountMessage).positive(amountMessage).max(MAX_EXPENSE_MINOR, 'El importe es demasiado grande'),
	/** The day the money was spent, as a calendar day without time zone. */
	spentOn: z.string({ error: dayMessage }).refine(isCalendarDate, dayMessage)
};

export const expenseInputSchema = z.object(expenseFields);
export type ExpenseInput = z.infer<typeof expenseInputSchema>;

export const expensePatchSchema = z
	.object(expenseFields)
	.partial()
	.refine((patch) => Object.keys(patch).length > 0, 'Indicá qué cambiar del gasto');
export type ExpensePatch = z.infer<typeof expensePatchSchema>;

export interface CampaignResultInput {
	/** Every charged order: paid, refunded or charged back. */
	salesMinor: number;
	refundsMinor: number;
	/** Mercado Pago fees reported for the approved payments. */
	feesMinor: number;
	prizesMinor: number;
	expensesMinor: number;
}

/** The result of a campaign, or of the whole organization (S5): sales − refunds − fees − prizes − expenses. */
export function campaignResult(input: CampaignResultInput): number {
	return input.salesMinor - input.refundsMinor - input.feesMinor - input.prizesMinor - input.expensesMinor;
}

/**
 * Whether a campaign's declared prizes are a cost: once it opened. An archived campaign may have
 * been archived before opening, so it counts only when it published its draw manifest.
 */
export function prizesCount(status: CampaignStatus, publishedManifest: boolean): boolean {
	if (status === 'archived') return publishedManifest;
	return ['open', 'closed', 'awarding', 'fulfilled'].includes(status);
}

/** The balance is final once the campaign stopped selling (S3); before that it is a projection. */
export function balanceIsFinal(status: CampaignStatus): boolean {
	return ['closed', 'awarding', 'fulfilled', 'archived'].includes(status);
}
