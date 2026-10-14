import { describe, expect, it } from 'vitest';
import {
	applyPaymentToOrder,
	mapMercadoPagoStatus,
	maskDocument,
	maskEmail,
	matchPaymentToOrder,
	normalizeDocument
} from '../src';

describe('order state from verified payments', () => {
	it('confirms exactly once', () => {
		const first = applyPaymentToOrder('pending_payment', 'approved');
		expect(first).toEqual({ status: 'paid', changed: true, effect: 'confirm' });
		expect(applyPaymentToOrder(first.status, 'approved')).toEqual({ status: 'paid', changed: false, effect: 'none' });
	});

	it('revokes on refund and chargeback without going back to pending', () => {
		expect(applyPaymentToOrder('paid', 'refunded').effect).toBe('revoke');
		expect(applyPaymentToOrder('paid', 'charged_back').status).toBe('charged_back');
		expect(applyPaymentToOrder('refunded', 'approved').changed).toBe(false);
	});

	it('lets a buyer retry after a rejected attempt', () => {
		const failed = applyPaymentToOrder('pending_payment', 'rejected');
		expect(failed.status).toBe('payment_failed');
		expect(applyPaymentToOrder(failed.status, 'approved').effect).toBe('confirm');
	});

	it('maps provider statuses conservatively', () => {
		expect(mapMercadoPagoStatus('in_mediation')).toBe('in_process');
		expect(mapMercadoPagoStatus('something_new')).toBe('pending');
	});

	it('rejects a payment that does not match the order', () => {
		const order = { reference: 'MG-ABC', totalMinor: 1_200_000, currency: 'ARS' };
		const facts = { externalReference: 'MG-ABC', amountMinor: 1_200_000, currency: 'ARS', collectorId: '42' };
		expect(matchPaymentToOrder(facts, order, '42')).toEqual({ ok: true });
		expect(matchPaymentToOrder({ ...facts, amountMinor: 100 }, order, '42')).toEqual({ ok: false, reason: 'amount_mismatch' });
		expect(matchPaymentToOrder({ ...facts, collectorId: '7' }, order, '42')).toEqual({ ok: false, reason: 'merchant_mismatch' });
		expect(matchPaymentToOrder({ ...facts, externalReference: 'MG-XYZ' }, order, '42').ok).toBe(false);
	});
});

describe('identity documents', () => {
	it('normalizes DNI formatting variants to one identifier', () => {
		const a = normalizeDocument('DNI', '30.123.456');
		const b = normalizeDocument('DNI', ' 30123456 ');
		expect(a).toEqual({ ok: true, type: 'DNI', number: '30123456' });
		expect(b).toEqual(a);
		expect(normalizeDocument('DNI', '1234567')).toEqual({ ok: true, type: 'DNI', number: '01234567' });
	});

	it('validates CUIT check digits', () => {
		expect(normalizeDocument('CUIT', '20-12345678-6').ok).toBe(true);
		expect(normalizeDocument('CUIT', '20-12345678-5')).toEqual({ ok: false, reason: 'invalid_check_digit' });
	});

	it('rejects malformed values', () => {
		expect(normalizeDocument('DNI', '12ab').ok).toBe(false);
		expect(normalizeDocument('DNI', '')).toEqual({ ok: false, reason: 'empty' });
	});

	it('masks documents and emails', () => {
		expect(maskDocument('30123456')).toBe('*****456');
		expect(maskEmail('juana@example.com')).toBe('ju***@example.com');
	});
});
