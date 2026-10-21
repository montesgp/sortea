import { chancesText } from './chances';
import { money } from './format';

/** Spanish copy for reconciliation results (FR-PAY-05). Amounts arrive in minor units. */

export type Facts = Record<string, string | number | null>;

export const discrepancyLabel: Record<string, string> = {
	payment_missing_in_system: 'Pago sin registrar',
	payment_missing_at_provider: 'Pago inexistente en Mercado Pago',
	unknown_reference: 'Referencia sin orden',
	amount_mismatch: 'Monto distinto',
	status_mismatch: 'Estado distinto',
	refund_not_applied: 'Reintegro sin aplicar',
	partial_refund: 'Reintegro parcial',
	settlement_amount_mismatch: 'Liquidación distinta',
	settlement_missing: 'Liquidación faltante',
	settlement_unmatched: 'Liquidación sin pago',
	pool_exhausted: 'Pago sin cupones'
};

export const paymentStatusLabel: Record<string, string> = {
	pending: 'pendiente',
	in_process: 'en proceso',
	approved: 'aprobado',
	rejected: 'rechazado',
	cancelled: 'cancelado',
	refunded: 'reintegrado',
	charged_back: 'con contracargo'
};

export const resolutionLabel: Record<string, string> = {
	provider_state_applied: 'Se aplicó el estado de Mercado Pago',
	cleared: 'Se resolvió sola',
	accepted: 'Aceptada con explicación'
};

/** Outcome of re-reading a payment and applying it like a webhook would. */
export const applyOutcomeLabel: Record<string, string> = {
	paid: 'la orden quedó pagada',
	refunded: 'la orden quedó reintegrada',
	charged_back: 'la orden quedó con contracargo',
	payment_failed: 'la orden quedó con pago rechazado',
	no_change: 'la orden no cambió',
	unknown_order: 'el pago no corresponde a ninguna orden',
	reference_mismatch: 'la referencia no coincide con la orden',
	amount_mismatch: 'el monto no coincide con la orden',
	currency_mismatch: 'la moneda no coincide con la orden',
	merchant_mismatch: 'el pago es de otra cuenta de Mercado Pago'
};

const amount = (value: string | number | null | undefined, currency: string) => (typeof value === 'number' ? money(value, currency) : 'sin dato');
const status = (value: string | number | null | undefined) => (typeof value === 'string' ? (paymentStatusLabel[value] ?? value) : 'sin dato');

/** One sentence that explains the difference to a finance person. */
export function describeDiscrepancy(kind: string, expected: Facts, observed: Facts, currency: string): string {
	switch (kind) {
		case 'payment_missing_in_system':
			return `Mercado Pago informa un pago ${status(observed.status)} de ${amount(observed.amountMinor, currency)} que la plataforma no registró. Probablemente no llegó la notificación.`;
		case 'payment_missing_at_provider':
			return `La plataforma registró un pago ${status(expected.status)} de ${amount(expected.amountMinor, currency)} que Mercado Pago no devuelve.`;
		case 'unknown_reference':
			return `Pago ${status(observed.status)} de ${amount(observed.amountMinor, currency)} con referencia ${observed.externalReference ?? ''} que no corresponde a ninguna orden.`;
		case 'amount_mismatch':
			return `Se esperaba ${amount(expected.amountMinor, currency)} y Mercado Pago informa ${amount(observed.amountMinor, String(observed.currency ?? currency))}.`;
		case 'status_mismatch':
			return `En la plataforma el pago está ${status(expected.status)}; en Mercado Pago, ${status(observed.status)}.`;
		case 'refund_not_applied':
			return observed.reversal
				? `El reporte de liquidaciones tiene un movimiento ${String(observed.reversal).toLowerCase()} y la plataforma tiene el pago ${status(expected.status)}.`
				: `Mercado Pago informa el pago ${status(observed.status)} y la plataforma lo tiene ${status(expected.status)}.`;
		case 'partial_refund':
			return `Se reintegraron ${amount(observed.refundedMinor, currency)} de ${amount(observed.amountMinor, currency)}. La plataforma no registra reintegros parciales: la orden sigue pagada.`;
		case 'settlement_amount_mismatch':
			return `Liquidado: bruto ${amount(observed.grossMinor, currency)}, neto ${amount(observed.netMinor, currency)}. Esperado: bruto ${amount(expected.grossMinor, currency)}, neto ${amount(expected.netMinor, currency)}.`;
		case 'settlement_missing':
			return `Pago aprobado de ${amount(expected.grossMinor, currency)} que debía liberarse en el período del reporte y no figura en él.`;
		case 'settlement_unmatched':
			return `El reporte liquida ${amount(observed.netMinor, currency)} para una referencia propia sin pago registrado en la plataforma.`;
		case 'pool_exhausted':
			return `El pago de ${amount(expected.amountMinor, currency)} se aprobó cuando no quedaban cupones: la orden no recibió sus ${typeof expected.entries === 'number' ? chancesText(expected.entries) : 'chances'}. Reintegrá el pago y aceptá la diferencia con una nota.`;
		default:
			return 'Diferencia sin descripción';
	}
}
