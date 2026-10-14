import { describe, expect, it } from 'vitest';
import {
	compareOperation,
	compareSettlements,
	parseCsv,
	parseDecimalMinor,
	parseSettlementReport,
	referenceMatcher,
	toCsv,
	type ProviderOperation,
	type SettlementExpectation,
	type SystemPayment
} from '../src';

const owns = referenceMatcher('MG');
const order = { reference: 'MG-7K2Q9XHD', totalMinor: 1_200_000, currency: 'ARS' };
const provider: ProviderOperation = { id: '111', status: 'approved', externalReference: order.reference, amountMinor: 1_200_000, currency: 'ARS', refundedMinor: 0 };
const system: SystemPayment = { providerPaymentId: '111', status: 'approved', amountMinor: 1_200_000, currency: 'ARS', orderReference: order.reference };

describe('operation reconciliation', () => {
	it('finds nothing when both sides agree', () => {
		expect(compareOperation({ provider, system, order, ownsReference: owns })).toEqual([]);
	});

	it('detects a payment the platform never recorded (lost webhook)', () => {
		const [found] = compareOperation({ provider, system: null, order, ownsReference: owns });
		expect(found).toMatchObject({ kind: 'payment_missing_in_system', severity: 'critical', providerPaymentId: '111', fingerprint: 'payment_missing_in_system:111' });
	});

	it('ignores rejected attempts and sales that are not ours', () => {
		expect(compareOperation({ provider: { ...provider, status: 'rejected' }, system: null, order, ownsReference: owns })).toEqual([]);
		expect(compareOperation({ provider: { ...provider, externalReference: 'POS-123' }, system: null, order: null, ownsReference: owns })).toEqual([]);
	});

	it('flags our reference format without an order', () => {
		const [found] = compareOperation({ provider: { ...provider, externalReference: 'MG-AAAAAAAA' }, system: null, order: null, ownsReference: owns });
		expect(found?.kind).toBe('unknown_reference');
	});

	it('detects a payment the provider does not have', () => {
		const [found] = compareOperation({ provider: null, system, order, ownsReference: owns });
		expect(found).toMatchObject({ kind: 'payment_missing_at_provider', severity: 'critical' });
	});

	it('detects a different amount, against the payment or the order', () => {
		expect(compareOperation({ provider: { ...provider, amountMinor: 1_000_000 }, system, order, ownsReference: owns }).map((d) => d.kind)).toEqual(['amount_mismatch']);
		const [unrecorded] = compareOperation({ provider: { ...provider, amountMinor: 1_000_000 }, system: null, order, ownsReference: owns });
		expect(unrecorded).toMatchObject({ kind: 'amount_mismatch', expected: { amountMinor: 1_200_000 }, observed: { amountMinor: 1_000_000 } });
	});

	it('detects refunds and chargebacks the platform has not applied', () => {
		const [refund] = compareOperation({ provider: { ...provider, status: 'refunded', refundedMinor: 1_200_000 }, system, order, ownsReference: owns });
		expect(refund).toMatchObject({ kind: 'refund_not_applied', severity: 'critical' });
		const [chargeback] = compareOperation({ provider: { ...provider, status: 'charged_back' }, system, order, ownsReference: owns });
		expect(chargeback?.kind).toBe('refund_not_applied');
	});

	it('reports other status differences and partial refunds', () => {
		const [status] = compareOperation({ provider, system: { ...system, status: 'in_process' }, order, ownsReference: owns });
		expect(status).toMatchObject({ kind: 'status_mismatch', severity: 'critical' });
		const [partial] = compareOperation({ provider: { ...provider, refundedMinor: 200_000 }, system, order, ownsReference: owns });
		expect(partial).toMatchObject({ kind: 'partial_refund', observed: { refundedMinor: 200_000 } });
	});
});

const header = 'EXTERNAL_REFERENCE;SOURCE_ID;USER_ID;PAYMENT_METHOD_TYPE;PAYMENT_METHOD;SITE;TRANSACTION_TYPE;TRANSACTION_AMOUNT;TRANSACTION_CURRENCY;TRANSACTION_DATE;FEE_AMOUNT;SETTLEMENT_NET_AMOUNT;SETTLEMENT_CURRENCY;SETTLEMENT_DATE';
const line = (ref: string, id: string, type: string, gross: string, fee: string, net: string) =>
	`${ref};${id};42;credit_card;visa;MLA;${type};${gross};ARS;2026-10-20T10:00:00.000-03:00;${fee};${net};ARS;2026-10-20T10:00:05.000-03:00`;

describe('settlement report', () => {
	it('parses Mercado Pago movements into exact minor units', () => {
		const report = [header, line('MG-7K2Q9XHD', '111', 'SETTLEMENT', '12000.00', '-918.00', '11082.00'), 'Retiro;;42;;;MLA;WITHDRAWAL;-5000.00;ARS;;0;-5000.00;ARS;'].join('\n');
		const result = parseSettlementReport(report);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.skipped).toBe(1);
		expect(result.rows).toHaveLength(1);
		expect(result.rows[0]).toMatchObject({ sourceId: '111', transactionType: 'SETTLEMENT', grossMinor: 1_200_000, feeMinor: -91_800, netMinor: 1_108_200, currency: 'ARS' });
		expect(result.rows[0]!.settledAt?.toISOString()).toBe('2026-10-20T13:00:05.000Z');
	});

	it('rejects files that are not the settlement report', () => {
		expect(parseSettlementReport('')).toEqual({ ok: false, error: { kind: 'empty' } });
		const wrong = parseSettlementReport('DATE,AMOUNT\n2026-10-01,10');
		expect(wrong.ok || wrong.error.kind).toBe('missing_columns');
		const bad = parseSettlementReport([header, line('MG-7K2Q9XHD', '111', 'SETTLEMENT', '12.000,00', '0', '0')].join('\n'));
		expect(bad).toEqual({ ok: false, error: { kind: 'invalid_row', line: 2, column: 'TRANSACTION_AMOUNT' } });
	});

	it('parses decimals without floating point', () => {
		expect(parseDecimalMinor('0.1')).toBe(10);
		expect(parseDecimalMinor('-8.85')).toBe(-885);
		expect(parseDecimalMinor('1234,5')).toBe(123_450);
		expect(parseDecimalMinor('1e3')).toBeNull();
	});
});

describe('settlement reconciliation', () => {
	const period = { from: new Date('2026-10-01T00:00:00Z'), to: new Date('2026-10-31T23:59:59Z') };
	const payment: SettlementExpectation = {
		providerPaymentId: '111',
		orderReference: order.reference,
		status: 'approved',
		amountMinor: 1_200_000,
		currency: 'ARS',
		netMinor: 1_108_200,
		releaseDate: new Date('2026-10-20T13:00:00Z')
	};
	const rows = (text: string[]) => {
		const result = parseSettlementReport([header, ...text].join('\n'));
		if (!result.ok) throw new Error('fixture');
		return result.rows;
	};

	it('matches a settled payment', () => {
		const settled = rows([line(order.reference, '111', 'SETTLEMENT', '12000.00', '-918.00', '11082.00')]);
		expect(compareSettlements({ rows: settled, payments: [payment], period, ownsReference: owns })).toEqual([]);
	});

	it('detects settlement discrepancies', () => {
		const lessNet = rows([line(order.reference, '111', 'SETTLEMENT', '12000.00', '-1918.00', '10082.00')]);
		const [net] = compareSettlements({ rows: lessNet, payments: [payment], period, ownsReference: owns });
		expect(net).toMatchObject({ kind: 'settlement_amount_mismatch', severity: 'warning', observed: { netMinor: 1_008_200 } });

		const lessGross = rows([line(order.reference, '111', 'SETTLEMENT', '10000.00', '-918.00', '9082.00')]);
		expect(compareSettlements({ rows: lessGross, payments: [payment], period, ownsReference: owns })[0]?.severity).toBe('critical');
	});

	it('detects missing, unknown and refunded settlements', () => {
		expect(compareSettlements({ rows: [], payments: [payment], period, ownsReference: owns }).map((d) => d.kind)).toEqual(['settlement_missing']);
		const outside = { from: new Date('2026-11-01T00:00:00Z'), to: new Date('2026-11-30T00:00:00Z') };
		expect(compareSettlements({ rows: [], payments: [payment], period: outside, ownsReference: owns })).toEqual([]);

		const unknown = rows([line('MG-ZZZZZZZZ', '999', 'SETTLEMENT', '100.00', '0', '100.00'), line('POS-1', '998', 'SETTLEMENT', '100.00', '0', '100.00')]);
		expect(compareSettlements({ rows: unknown, payments: [], period, ownsReference: owns }).map((d) => d.kind)).toEqual(['settlement_unmatched']);

		const refunded = rows([
			line(order.reference, '111', 'SETTLEMENT', '12000.00', '-918.00', '11082.00'),
			line(order.reference, '111', 'REFUND', '-12000.00', '918.00', '-11082.00')
		]);
		expect(compareSettlements({ rows: refunded, payments: [payment], period, ownsReference: owns }).map((d) => d.kind)).toEqual(['refund_not_applied']);
		expect(compareSettlements({ rows: refunded, payments: [{ ...payment, status: 'refunded' }], period, ownsReference: owns })).toEqual([]);
	});
});

describe('csv', () => {
	it('neutralises formulas in text cells and quotes separators', () => {
		const csv = toCsv(['a', 'b', 'c'], [['=HYPERLINK("x")', -885, 'Pérez, Ana']]);
		expect(csv).toBe('\uFEFFa,b,c\r\n"\'=HYPERLINK(""x"")",-885,"Pérez, Ana"\r\n');
		expect(parseCsv(csv, ',')).toEqual([
			['a', 'b', 'c'],
			['\'=HYPERLINK("x")', '-885', 'Pérez, Ana']
		]);
	});

	it('recognises only the organization reference format', () => {
		expect(owns('MG-7K2Q9XHD')).toBe(true);
		expect(owns('MGX-7K2Q9XHD')).toBe(false);
		expect(referenceMatcher('moto')('MOTO-7K2Q9XHD')).toBe(true);
	});
});
