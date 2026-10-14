import { detectDelimiter, parseCsv } from './csv';
import type { PaymentStatus } from './payments';

/**
 * Reconciliation rules (FR-PAY-05, AC-09). Pure comparisons between what the
 * platform recorded and what the payment provider reports. They only describe
 * differences; resolving one is always a human decision, and the only way to
 * change an order is to re-read the payment from the provider.
 */
export const discrepancyKinds = [
	/** The provider has a payment for one of our orders that the platform never recorded (lost webhook). */
	'payment_missing_in_system',
	/** The platform recorded a payment the provider does not return. */
	'payment_missing_at_provider',
	/** A payment carries one of our reference formats but no order has that reference. */
	'unknown_reference',
	'amount_mismatch',
	'status_mismatch',
	/** The provider refunded or charged back money the platform still counts as approved. */
	'refund_not_applied',
	/** Part of an approved payment was returned; the platform does not model partial refunds. */
	'partial_refund',
	/** The settlement report disagrees with the payment's gross or net amount. */
	'settlement_amount_mismatch',
	/** An approved payment should have been released in the report period but is not in it. */
	'settlement_missing',
	/** The settlement report has money for one of our references that the platform does not know. */
	'settlement_unmatched'
] as const;
export type DiscrepancyKind = (typeof discrepancyKinds)[number];

export const discrepancySeverities = ['critical', 'warning'] as const;
export type DiscrepancySeverity = (typeof discrepancySeverities)[number];

export interface Discrepancy {
	readonly kind: DiscrepancyKind;
	readonly severity: DiscrepancySeverity;
	readonly providerPaymentId: string | null;
	readonly orderReference: string | null;
	/** What the platform holds (or expects). Amounts in minor units. */
	readonly expected: Readonly<Record<string, string | number | null>>;
	/** What the provider reports. */
	readonly observed: Readonly<Record<string, string | number | null>>;
	/** Stable identity: the same difference found by two runs is one item. */
	readonly fingerprint: string;
}

/** Discrepancies that a fresh read of the payment from the provider can settle. */
export const providerStateKinds: readonly DiscrepancyKind[] = ['payment_missing_in_system', 'status_mismatch', 'refund_not_applied'];

/** Payment facts as read from the provider API, already mapped to internal statuses. */
export interface ProviderOperation {
	readonly id: string;
	readonly status: PaymentStatus;
	readonly externalReference: string | null;
	readonly amountMinor: number;
	readonly currency: string;
	readonly refundedMinor: number;
}

export interface SystemPayment {
	readonly providerPaymentId: string;
	readonly status: PaymentStatus;
	readonly amountMinor: number;
	readonly currency: string;
	readonly orderReference: string;
}

export interface OrderFacts {
	readonly reference: string;
	readonly totalMinor: number;
	readonly currency: string;
}

const moneyMoved: readonly PaymentStatus[] = ['approved', 'refunded', 'charged_back'];
const reversed: readonly PaymentStatus[] = ['refunded', 'charged_back'];

function fingerprint(kind: DiscrepancyKind, key: string): string {
	return `${kind}:${key}`;
}

/**
 * Compares one payment as the platform and the provider see it. Either side
 * may be missing. `ownsReference` tells whether a reference has this
 * organization's format, so unrelated sales on the same account are ignored.
 */
export function compareOperation(input: {
	readonly provider: ProviderOperation | null;
	readonly system: SystemPayment | null;
	readonly order: OrderFacts | null;
	readonly ownsReference: (reference: string) => boolean;
}): Discrepancy[] {
	const { provider, system, order } = input;

	if (!provider && system) {
		return [
			{
				kind: 'payment_missing_at_provider',
				severity: 'critical',
				providerPaymentId: system.providerPaymentId,
				orderReference: system.orderReference,
				expected: { status: system.status, amountMinor: system.amountMinor, currency: system.currency },
				observed: { status: null },
				fingerprint: fingerprint('payment_missing_at_provider', system.providerPaymentId)
			}
		];
	}
	if (!provider) return [];

	const observed = {
		status: provider.status,
		amountMinor: provider.amountMinor,
		currency: provider.currency,
		refundedMinor: provider.refundedMinor,
		externalReference: provider.externalReference
	};

	if (!system) {
		// Only money that actually moved matters; a rejected attempt is noise.
		if (!moneyMoved.includes(provider.status)) return [];
		if (order) {
			if (order.totalMinor !== provider.amountMinor || order.currency !== provider.currency) {
				return [
					{
						kind: 'amount_mismatch',
						severity: 'critical',
						providerPaymentId: provider.id,
						orderReference: order.reference,
						expected: { amountMinor: order.totalMinor, currency: order.currency },
						observed,
						fingerprint: fingerprint('amount_mismatch', provider.id)
					}
				];
			}
			return [
				{
					kind: 'payment_missing_in_system',
					severity: 'critical',
					providerPaymentId: provider.id,
					orderReference: order.reference,
					expected: { status: null },
					observed,
					fingerprint: fingerprint('payment_missing_in_system', provider.id)
				}
			];
		}
		if (provider.externalReference && input.ownsReference(provider.externalReference)) {
			return [
				{
					kind: 'unknown_reference',
					severity: 'warning',
					providerPaymentId: provider.id,
					orderReference: provider.externalReference,
					expected: { order: null },
					observed,
					fingerprint: fingerprint('unknown_reference', provider.id)
				}
			];
		}
		return [];
	}

	const found: Discrepancy[] = [];
	const base = { providerPaymentId: provider.id, orderReference: system.orderReference };
	if (system.amountMinor !== provider.amountMinor || system.currency !== provider.currency) {
		found.push({
			...base,
			kind: 'amount_mismatch',
			severity: 'critical',
			expected: { amountMinor: system.amountMinor, currency: system.currency },
			observed,
			fingerprint: fingerprint('amount_mismatch', provider.id)
		});
	}
	if (system.status !== provider.status) {
		const refund = reversed.includes(provider.status) && !reversed.includes(system.status);
		found.push({
			...base,
			kind: refund ? 'refund_not_applied' : 'status_mismatch',
			severity: refund || provider.status === 'approved' || system.status === 'approved' ? 'critical' : 'warning',
			expected: { status: system.status },
			observed,
			fingerprint: fingerprint(refund ? 'refund_not_applied' : 'status_mismatch', provider.id)
		});
	}
	if (provider.status === 'approved' && provider.refundedMinor > 0) {
		found.push({
			...base,
			kind: 'partial_refund',
			severity: 'warning',
			expected: { refundedMinor: 0 },
			observed,
			fingerprint: fingerprint('partial_refund', provider.id)
		});
	}
	return found;
}

// ─── Settlement report ─────────────────────────────────────────────────────

/**
 * One movement of Mercado Pago's account money (settlement) report. Rows for
 * the same payment share `sourceId`: the sale, its refunds, chargebacks.
 */
export interface SettlementRow {
	readonly sourceId: string;
	readonly externalReference: string | null;
	readonly transactionType: string;
	readonly grossMinor: number;
	readonly feeMinor: number;
	readonly netMinor: number;
	readonly currency: string;
	readonly transactionAt: Date | null;
	readonly settledAt: Date | null;
	/** Stable identity of the movement, so uploading overlapping reports is idempotent. */
	readonly rowKey: string;
}

export type SettlementReportError =
	| { readonly kind: 'missing_columns'; readonly columns: readonly string[] }
	| { readonly kind: 'empty' }
	| { readonly kind: 'invalid_row'; readonly line: number; readonly column: string };

export type SettlementReportResult =
	| { readonly ok: true; readonly rows: readonly SettlementRow[]; readonly skipped: number }
	| { readonly ok: false; readonly error: SettlementReportError };

const requiredColumns = ['SOURCE_ID', 'TRANSACTION_TYPE', 'TRANSACTION_AMOUNT', 'SETTLEMENT_NET_AMOUNT'] as const;

/** Exact decimal string to minor units ("-8.85" → -885), without floating point. */
export function parseDecimalMinor(value: string): number | null {
	const match = /^(-)?(\d+)(?:[.,](\d{1,2}))?$/.exec(value.trim());
	if (!match) return null;
	const [, sign, units, fraction = ''] = match;
	const minor = Number(units) * 100 + Number(fraction.padEnd(2, '0'));
	if (!Number.isSafeInteger(minor)) return null;
	return sign && minor !== 0 ? -minor : minor;
}

function parseDate(value: string | undefined): Date | null {
	if (!value?.trim()) return null;
	const date = new Date(value.trim());
	return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Parses the report exported by Mercado Pago with English headers
 * (`header_language: en`). Only the columns needed for reconciliation are
 * read; rows without a payment id (withdrawals, account fees) are skipped.
 */
export function parseSettlementReport(text: string): SettlementReportResult {
	const firstLine = text.replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0] ?? '';
	if (!firstLine.trim()) return { ok: false, error: { kind: 'empty' } };
	const table = parseCsv(text, detectDelimiter(firstLine));
	const header = (table[0] ?? []).map((cell) => cell.trim().toUpperCase());
	const missing = requiredColumns.filter((column) => !header.includes(column));
	if (missing.length > 0) return { ok: false, error: { kind: 'missing_columns', columns: missing } };

	const column = (name: string) => header.indexOf(name);
	const at = (cells: string[], name: string) => {
		const index = column(name);
		return index >= 0 ? (cells[index] ?? '').trim() : '';
	};

	const rows: SettlementRow[] = [];
	let skipped = 0;
	for (let index = 1; index < table.length; index++) {
		const cells = table[index]!;
		const line = index + 1;
		const sourceId = at(cells, 'SOURCE_ID');
		if (!/^\d{1,20}$/.test(sourceId)) {
			skipped++;
			continue;
		}
		const amounts: Record<string, number> = {};
		for (const [key, name, required] of [
			['gross', 'TRANSACTION_AMOUNT', true],
			['net', 'SETTLEMENT_NET_AMOUNT', true],
			['fee', 'FEE_AMOUNT', false]
		] as const) {
			const raw = at(cells, name);
			if (!raw && !required) {
				amounts[key] = 0;
				continue;
			}
			const parsed = parseDecimalMinor(raw);
			if (parsed === null) return { ok: false, error: { kind: 'invalid_row', line, column: name } };
			amounts[key] = parsed;
		}
		const transactionType = at(cells, 'TRANSACTION_TYPE').toUpperCase();
		const transactionAt = parseDate(at(cells, 'TRANSACTION_DATE'));
		const settledAt = parseDate(at(cells, 'SETTLEMENT_DATE'));
		const currency = (at(cells, 'SETTLEMENT_CURRENCY') || at(cells, 'TRANSACTION_CURRENCY') || 'ARS').toUpperCase();
		rows.push({
			sourceId,
			externalReference: at(cells, 'EXTERNAL_REFERENCE') || null,
			transactionType,
			grossMinor: amounts.gross!,
			feeMinor: amounts.fee!,
			netMinor: amounts.net!,
			currency,
			transactionAt,
			settledAt,
			rowKey: [sourceId, transactionType, transactionAt?.toISOString() ?? '', settledAt?.toISOString() ?? '', amounts.net].join('|')
		});
	}
	return { ok: true, rows, skipped };
}

/** Settlement facts the platform holds for a payment. */
export interface SettlementExpectation {
	readonly providerPaymentId: string;
	readonly orderReference: string;
	readonly status: PaymentStatus;
	readonly amountMinor: number;
	readonly currency: string;
	/** Net amount the provider reported for the payment, when known. */
	readonly netMinor: number | null;
	/** When the provider said the money would be released, when known. */
	readonly releaseDate: Date | null;
}

const isSale = (type: string) => type === 'SETTLEMENT';
const isReversal = (type: string) => type.startsWith('REFUND') || type.startsWith('CHARGEBACK');

/**
 * Compares settlement movements with the platform's payments. `rows` must
 * hold every stored movement for the payments involved (a refund may arrive in
 * a later report than the sale). `period` is the span the uploaded report
 * covers: approved payments due for release inside it must appear in it.
 */
export function compareSettlements(input: {
	readonly rows: readonly SettlementRow[];
	readonly payments: readonly SettlementExpectation[];
	readonly period: { readonly from: Date; readonly to: Date };
	readonly ownsReference: (reference: string) => boolean;
}): Discrepancy[] {
	const bySource = new Map<string, SettlementRow[]>();
	for (const row of input.rows) bySource.set(row.sourceId, [...(bySource.get(row.sourceId) ?? []), row]);
	const payments = new Map(input.payments.map((payment) => [payment.providerPaymentId, payment]));
	const found: Discrepancy[] = [];

	for (const [sourceId, rows] of bySource) {
		const payment = payments.get(sourceId);
		const reference = rows.find((row) => row.externalReference)?.externalReference ?? null;
		const totals = rows.reduce(
			(sum, row) => (isSale(row.transactionType) ? { gross: sum.gross + row.grossMinor, net: sum.net + row.netMinor, fee: sum.fee + row.feeMinor } : sum),
			{ gross: 0, net: 0, fee: 0 }
		);
		const observed = { grossMinor: totals.gross, netMinor: totals.net, feeMinor: totals.fee, movements: rows.length };

		if (!payment) {
			if (reference && input.ownsReference(reference)) {
				found.push({
					kind: 'settlement_unmatched',
					severity: 'critical',
					providerPaymentId: sourceId,
					orderReference: reference,
					expected: { payment: null },
					observed,
					fingerprint: fingerprint('settlement_unmatched', sourceId)
				});
			}
			continue;
		}

		const base = { providerPaymentId: sourceId, orderReference: payment.orderReference };
		const hasSale = rows.some((row) => isSale(row.transactionType));
		const grossDiffers = hasSale && (totals.gross !== payment.amountMinor || rows.some((row) => row.currency !== payment.currency));
		const netDiffers = hasSale && payment.netMinor !== null && totals.net !== payment.netMinor;
		if (grossDiffers || netDiffers) {
			found.push({
				...base,
				kind: 'settlement_amount_mismatch',
				severity: grossDiffers ? 'critical' : 'warning',
				expected: { grossMinor: payment.amountMinor, netMinor: payment.netMinor, currency: payment.currency },
				observed,
				fingerprint: fingerprint('settlement_amount_mismatch', sourceId)
			});
		}
		if (rows.some((row) => isReversal(row.transactionType)) && !reversed.includes(payment.status)) {
			found.push({
				...base,
				kind: 'refund_not_applied',
				severity: 'critical',
				expected: { status: payment.status },
				observed: { ...observed, reversal: rows.find((row) => isReversal(row.transactionType))!.transactionType },
				fingerprint: fingerprint('refund_not_applied', sourceId)
			});
		}
	}

	for (const payment of input.payments) {
		if (payment.status !== 'approved' || !payment.releaseDate) continue;
		if (payment.releaseDate < input.period.from || payment.releaseDate > input.period.to) continue;
		if ((bySource.get(payment.providerPaymentId) ?? []).some((row) => isSale(row.transactionType))) continue;
		found.push({
			kind: 'settlement_missing',
			severity: 'warning',
			providerPaymentId: payment.providerPaymentId,
			orderReference: payment.orderReference,
			expected: { grossMinor: payment.amountMinor, releaseDate: payment.releaseDate.toISOString() },
			observed: { movements: 0 },
			fingerprint: fingerprint('settlement_missing', payment.providerPaymentId)
		});
	}
	return found;
}

/**
 * Whether a reference has the organization's order format (`MG-7K2Q9XHD`),
 * mirroring `generateOrderReference`.
 */
export function referenceMatcher(orderPrefix: string): (reference: string) => boolean {
	const escaped = orderPrefix.toUpperCase().slice(0, 4).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const pattern = new RegExp(`^${escaped}-[A-Z0-9]{8}$`);
	return (reference) => pattern.test(reference);
}
