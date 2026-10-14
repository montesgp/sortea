import { formatMoney, type CurrencyCode } from '@sortea/domain';

export function money(amountMinor: number, currency = 'ARS'): string {
	return formatMoney({ amountMinor, currency: currency as CurrencyCode }).replace(/\u00a0/g, ' ');
}

/** Dates are stored in UTC and always shown in the campaign or organization time zone. */
export function dateTime(iso: string | Date, timeZone: string, style: 'long' | 'short' = 'long'): string {
	return new Intl.DateTimeFormat('es-AR', {
		timeZone,
		day: 'numeric',
		month: style === 'long' ? 'long' : 'short',
		year: style === 'long' ? 'numeric' : undefined,
		hour: '2-digit',
		minute: '2-digit',
		hour12: false
	}).format(new Date(iso));
}

export function dateOnly(iso: string | Date, timeZone: string): string {
	return new Intl.DateTimeFormat('es-AR', { timeZone, day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(iso));
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
