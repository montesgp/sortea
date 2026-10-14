import { discrepancyKinds } from '@sortea/domain';
import { describe, expect, it } from 'vitest';
import { describeDiscrepancy, discrepancyLabel } from './reconciliation';

describe('reconciliation copy', () => {
	it('explains each difference with formatted amounts', () => {
		expect(describeDiscrepancy('amount_mismatch', { amountMinor: 2_400_000, currency: 'ARS' }, { amountMinor: 2_300_000, currency: 'ARS' }, 'ARS')).toBe(
			'Se esperaba $ 24.000 y Mercado Pago informa $ 23.000.'
		);
		expect(describeDiscrepancy('refund_not_applied', { status: 'approved' }, { status: 'refunded' }, 'ARS')).toBe(
			'Mercado Pago informa el pago reintegrado y la plataforma lo tiene aprobado.'
		);
		expect(describeDiscrepancy('settlement_missing', { grossMinor: 1_050 }, { movements: 0 }, 'ARS')).toContain('$ 10,50');
	});

	it('labels every kind the API can report', () => {
		for (const kind of discrepancyKinds) {
			expect(discrepancyLabel[kind]).toBeTruthy();
			expect(describeDiscrepancy(kind, {}, {}, 'ARS')).not.toBe('Diferencia sin descripción');
		}
	});
});
