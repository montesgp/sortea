import { formatDate, formatDateTime, formatMoney, type CurrencyCode } from '@sortea/domain';

export function money(amountMinor: number, currency = 'ARS'): string {
	return formatMoney({ amountMinor, currency: currency as CurrencyCode }).replace(/\u00a0/g, ' ');
}

/**
 * Dates are stored in UTC and always shown in the campaign or organization time zone,
 * as dd/MM/yyyy HH:mm (24 h) with the domain's formatter (draw room S1).
 */
export function dateTime(iso: string | Date, timeZone: string): string {
	return formatDateTime(iso, timeZone);
}

/** A day alone, dd/MM/yyyy. */
export function dateOnly(iso: string | Date, timeZone: string): string {
	return formatDate(iso, timeZone);
}

/** A calendar day the API already sends as YYYY-MM-DD in the organization time zone, as dd/MM/yyyy. */
export function calendarDay(day: string): string {
	const [year, month, date] = day.split('-');
	return `${date}/${month}/${year}`;
}

export const campaignStatusLabel: Record<string, { label: string; tone: 'ok' | 'warn' | 'bad' | 'neutral' }> = {
	draft: { label: 'Borrador', tone: 'neutral' },
	review: { label: 'En revisión', tone: 'neutral' },
	published: { label: 'Próximamente', tone: 'warn' },
	open: { label: 'Participaciones abiertas', tone: 'ok' },
	closed: { label: 'Cerrada', tone: 'neutral' },
	awarding: { label: 'Adjudicando premios', tone: 'warn' },
	fulfilled: { label: 'Premios entregados', tone: 'ok' },
	archived: { label: 'Archivada', tone: 'neutral' }
};

/**
 * The admin's status chip of a campaign: a draft or one in review still without
 * its opening or closing says so, "Borrador · fechas a definir" (S5, owner feedback 2026-11-10).
 */
export function campaignStatusChip(campaign: { status: string; opensAt: string | null; closesAt: string | null }): { label: string; tone: 'ok' | 'warn' | 'bad' | 'neutral' } {
	const status = campaignStatusLabel[campaign.status] ?? { label: campaign.status, tone: 'neutral' as const };
	const undated = !campaign.opensAt || !campaign.closesAt;
	return undated && ['draft', 'review'].includes(campaign.status) ? { ...status, label: `${status.label} · fechas a definir` } : status;
}

/** A campaign date in the admin, or "A definir" while a draft waits for it. */
export function campaignDate(iso: string | null, timeZone: string): string {
	return iso ? dateTime(iso, timeZone) : 'A definir';
}

export const orderStatusLabel: Record<string, { label: string; tone: 'ok' | 'warn' | 'bad' | 'neutral' }> = {
	pending_payment: { label: 'Esperando pago', tone: 'warn' },
	paid: { label: 'Pagada', tone: 'ok' },
	payment_failed: { label: 'Pago rechazado', tone: 'bad' },
	refunded: { label: 'Reintegrada', tone: 'neutral' },
	charged_back: { label: 'Contracargo', tone: 'bad' },
	expired: { label: 'Vencida', tone: 'neutral' }
};

export const prizeKindLabel: Record<string, string> = {
	vehicle: 'Vehículo',
	cash: 'Dinero',
	product: 'Producto',
	digital: 'Digital'
};
