import { and, desc, eq, gte, inArray, isNotNull, lt, lte, or, schema as s, sql, type ReconciliationSummary, type Tx } from '@sortea/db';
import {
	compareOperation,
	compareSettlements,
	mapMercadoPagoStatus,
	parseSettlementReport,
	providerStateKinds,
	referenceMatcher,
	type Discrepancy,
	type DiscrepancyKind,
	type OrderFacts,
	type ProviderOperation,
	type SettlementReportError,
	type SettlementRow
} from '@sortea/domain';
import { sha256Hex } from '@sortea/domain/server';
import type { AppDeps } from '../context';
import { audit, type AuditInput } from '../lib/audit';
import { ApiError, notFound } from '../lib/errors';
import { applyVerifiedPayment, providerFinancials } from '../payments/confirm';
import { loadMercadoPago, type ActiveIntegration } from '../payments/integrations';
import { ProviderError, type ProviderPayment } from '../payments/provider';

/**
 * Reconciliation (FR-PAY-05, AC-09). Runs inside the API because only the API
 * opens the organization's provider credentials (ADR 0004); the worker just
 * calls it on a schedule. Every finding becomes an open item that a person
 * resolves. Nothing here approves a payment: the only way an order changes is
 * the same verified provider read that a webhook triggers.
 */

export const operationKinds: readonly DiscrepancyKind[] = [
	'payment_missing_in_system',
	'payment_missing_at_provider',
	'unknown_reference',
	'amount_mismatch',
	'status_mismatch',
	'refund_not_applied',
	'partial_refund'
];
const settlementOnlyKinds: readonly DiscrepancyKind[] = ['settlement_amount_mismatch', 'settlement_missing', 'settlement_unmatched'];

const PAGE_SIZE = 100;
/** Payments examined per run; a larger backlog continues in the next run. */
const MAX_EXAMINED = 5_000;
const MAX_RECHECKS = 200;
const OVERLAP_MS = 30 * 60_000;
const FIRST_WINDOW_MS = 3 * 86_400_000;
const MAX_WINDOW_MS = 31 * 86_400_000;
const STALE_RUN_MS = 30 * 60_000;

export type RunOutcome = { status: 'completed'; runId: string; summary: ReconciliationSummary } | { status: 'busy' };

type RunValues = Pick<typeof s.reconciliationRuns.$inferInsert, 'kind' | 'trigger' | 'windowFrom' | 'windowTo' | 'startedBy'>;

/** Claims the organization's single running slot for this kind, or returns null when another run holds it. */
async function startRun(deps: AppDeps, organizationId: string, values: RunValues): Promise<string | null> {
	const now = deps.now();
	return deps.db.withTenant(organizationId, async (tx) => {
		await tx
			.update(s.reconciliationRuns)
			.set({ status: 'failed', finishedAt: now, error: 'Interrumpida: superó el tiempo máximo de ejecución' })
			.where(
				and(
					eq(s.reconciliationRuns.kind, values.kind),
					eq(s.reconciliationRuns.status, 'running'),
					lt(s.reconciliationRuns.startedAt, new Date(now.getTime() - STALE_RUN_MS))
				)
			);
		const [run] = await tx
			.insert(s.reconciliationRuns)
			.values({ organizationId, ...values, startedAt: now })
			.onConflictDoNothing()
			.returning({ id: s.reconciliationRuns.id });
		return run?.id ?? null;
	});
}

async function finishRun(deps: AppDeps, organizationId: string, runId: string, values: Partial<typeof s.reconciliationRuns.$inferInsert>) {
	await deps.db.withTenant(organizationId, (tx) =>
		tx
			.update(s.reconciliationRuns)
			.set({ ...values, finishedAt: deps.now() })
			.where(eq(s.reconciliationRuns.id, runId))
	);
}

function describeFailure(error: unknown): string {
	if (error instanceof ProviderError) return `Mercado Pago no respondió correctamente${error.status ? ` (HTTP ${error.status})` : ''}`;
	if (error instanceof ApiError) return error.message;
	return 'Error interno durante la conciliación';
}

function toOperation(payment: ProviderPayment): ProviderOperation {
	return {
		id: payment.id,
		status: mapMercadoPagoStatus(payment.status),
		externalReference: payment.externalReference,
		amountMinor: payment.amountMinor,
		currency: payment.currency,
		refundedMinor: payment.refundedMinor
	};
}

type Finding = Discrepancy & { readonly orderId: string | null };

async function recordFindings(tx: Tx, organizationId: string, runId: string, findings: readonly Finding[], now: Date) {
	for (const finding of findings) {
		await tx
			.insert(s.reconciliationItems)
			.values({
				organizationId,
				firstRunId: runId,
				lastRunId: runId,
				kind: finding.kind,
				severity: finding.severity,
				fingerprint: finding.fingerprint,
				providerPaymentId: finding.providerPaymentId,
				orderReference: finding.orderReference,
				orderId: finding.orderId,
				expected: finding.expected,
				observed: finding.observed,
				firstSeenAt: now,
				lastSeenAt: now
			})
			.onConflictDoUpdate({
				target: [s.reconciliationItems.organizationId, s.reconciliationItems.fingerprint],
				targetWhere: sql`status = 'open'`,
				set: { lastRunId: runId, lastSeenAt: now, severity: finding.severity, expected: finding.expected, observed: finding.observed, orderId: finding.orderId }
			});
	}
}

/** Open items of the given kinds about examined payments that this run no longer finds are cleared. */
async function clearSettled(
	tx: Tx,
	input: { runId: string; examined: readonly string[]; kinds: readonly DiscrepancyKind[]; current: ReadonlySet<string>; now: Date }
): Promise<number> {
	if (input.examined.length === 0) return 0;
	const open = await tx
		.select({ id: s.reconciliationItems.id, fingerprint: s.reconciliationItems.fingerprint })
		.from(s.reconciliationItems)
		.where(
			and(
				eq(s.reconciliationItems.status, 'open'),
				inArray(s.reconciliationItems.kind, [...input.kinds]),
				inArray(s.reconciliationItems.providerPaymentId, [...input.examined])
			)
		);
	const settled = open.filter((item) => !input.current.has(item.fingerprint)).map((item) => item.id);
	if (settled.length > 0) {
		await tx
			.update(s.reconciliationItems)
			.set({ status: 'resolved', resolution: 'cleared', resolutionNote: 'La conciliación ya no encuentra la diferencia', resolvedAt: input.now, lastRunId: input.runId })
			.where(inArray(s.reconciliationItems.id, settled));
	}
	return settled.length;
}

async function orderPrefix(tx: Tx, organizationId: string): Promise<string> {
	const [organization] = await tx.select({ orderPrefix: s.organizations.orderPrefix }).from(s.organizations).where(eq(s.organizations.id, organizationId));
	if (!organization) throw notFound('Organización');
	return organization.orderPrefix;
}

async function paymentsWithOrders(tx: Tx, providerPaymentIds: readonly string[]) {
	if (providerPaymentIds.length === 0) return [];
	return tx
		.select({ payment: s.payments, reference: s.orders.reference })
		.from(s.payments)
		.innerJoin(s.orders, eq(s.orders.id, s.payments.orderId))
		.where(inArray(s.payments.providerPaymentId, [...providerPaymentIds]));
}

async function ordersByReference(tx: Tx, references: readonly string[]) {
	if (references.length === 0) return new Map<string, OrderFacts & { id: string }>();
	const rows = await tx
		.select({ id: s.orders.id, reference: s.orders.reference, totalMinor: s.orders.totalMinor, currency: s.orders.currency })
		.from(s.orders)
		.where(inArray(s.orders.reference, [...references]));
	return new Map(rows.map((row) => [row.reference, row]));
}

function financialsChanged(stored: typeof s.payments.$inferSelect, payment: ProviderPayment): boolean {
	return (
		stored.feeMinor !== payment.feeMinor ||
		stored.netMinor !== payment.netMinor ||
		stored.refundedMinor !== payment.refundedMinor ||
		stored.releaseStatus !== payment.releaseStatus ||
		stored.releaseDate?.getTime() !== payment.releaseDate?.getTime()
	);
}

// ─── Operations ────────────────────────────────────────────────────────────

/**
 * Compares the provider's payments updated in a window with the platform's,
 * and re-reads every payment the platform touched in that window or that has
 * an open item, so a payment missing at the provider is found too.
 */
export async function runOperations(
	deps: AppDeps,
	organizationId: string,
	options: { trigger: 'scheduled' | 'manual'; from?: Date; to?: Date; startedBy?: string | null }
): Promise<RunOutcome> {
	const setup = await deps.db.withTenant(organizationId, async (tx) => {
		const [last] = await tx
			.select({ windowTo: s.reconciliationRuns.windowTo })
			.from(s.reconciliationRuns)
			.where(and(eq(s.reconciliationRuns.kind, 'operations'), eq(s.reconciliationRuns.status, 'completed')))
			.orderBy(desc(s.reconciliationRuns.windowTo))
			.limit(1);
		return {
			integration: await loadMercadoPago(tx, organizationId, deps.keyRing),
			prefix: await orderPrefix(tx, organizationId),
			lastWindowTo: last?.windowTo ?? null
		};
	});
	if (!setup.integration) throw new ApiError(409, 'payments_unavailable', 'La organización no tiene una cuenta de Mercado Pago activa');

	const to = options.to ?? deps.now();
	let from = options.from ?? (setup.lastWindowTo ? new Date(setup.lastWindowTo.getTime() - OVERLAP_MS) : new Date(to.getTime() - FIRST_WINDOW_MS));
	if (to.getTime() - from.getTime() > MAX_WINDOW_MS) from = new Date(to.getTime() - MAX_WINDOW_MS);
	if (from >= to) throw new ApiError(400, 'invalid_window', 'El inicio del período tiene que ser anterior al fin');

	const runId = await startRun(deps, organizationId, { kind: 'operations', trigger: options.trigger, windowFrom: from, windowTo: to, startedBy: options.startedBy ?? null });
	if (!runId) return { status: 'busy' };
	try {
		const { summary, windowTo } = await examineOperations(deps, organizationId, setup.integration, runId, { from, to }, referenceMatcher(setup.prefix));
		await finishRun(deps, organizationId, runId, { status: 'completed', summary, windowTo });
		return { status: 'completed', runId, summary };
	} catch (error) {
		await finishRun(deps, organizationId, runId, { status: 'failed', error: describeFailure(error) });
		throw error;
	}
}

async function examineOperations(
	deps: AppDeps,
	organizationId: string,
	integration: ActiveIntegration,
	runId: string,
	window: { from: Date; to: Date },
	ownsReference: (reference: string) => boolean
): Promise<{ summary: ReconciliationSummary; windowTo: Date }> {
	const now = deps.now();
	const provider = new Map<string, ProviderPayment | null>();
	let windowTo = window.to;
	for (let offset = 0; ; ) {
		const page = await deps.payments.searchPayments(integration.credentials, { updatedFrom: window.from, updatedTo: window.to, offset, limit: PAGE_SIZE });
		for (const payment of page.results) provider.set(payment.id, payment);
		offset += page.results.length;
		if (page.results.length === 0 || offset >= page.total) break;
		if (provider.size >= MAX_EXAMINED) {
			// Results are oldest first: the next run starts where this one stopped.
			windowTo = page.results.at(-1)?.updatedAt ?? window.to;
			break;
		}
	}

	const toRecheck = await deps.db.withTenant(organizationId, async (tx) => {
		const touched = await tx
			.select({ id: s.payments.providerPaymentId })
			.from(s.payments)
			.where(and(gte(s.payments.updatedAt, window.from), lte(s.payments.updatedAt, windowTo)));
		const open = await tx
			.select({ id: s.reconciliationItems.providerPaymentId })
			.from(s.reconciliationItems)
			.where(
				and(eq(s.reconciliationItems.status, 'open'), inArray(s.reconciliationItems.kind, [...operationKinds]), isNotNull(s.reconciliationItems.providerPaymentId))
			);
		return [...new Set([...touched, ...open].map((row) => row.id!))].filter((id) => !provider.has(id));
	});
	for (const id of toRecheck.slice(0, MAX_RECHECKS)) {
		try {
			provider.set(id, await deps.payments.getPayment(integration.credentials, id));
		} catch (error) {
			if (!(error instanceof ProviderError && error.status === 404)) throw error;
			provider.set(id, null);
		}
	}

	const summary = await deps.db.withTenant(organizationId, async (tx) => {
		const examined = [...provider.keys()];
		const recorded = new Map((await paymentsWithOrders(tx, examined)).map((row) => [row.payment.providerPaymentId, row]));
		const unrecordedReferences = [...provider.values()]
			.filter((payment): payment is ProviderPayment => payment !== null && !recorded.has(payment.id) && payment.externalReference !== null)
			.map((payment) => payment.externalReference!);
		const orders = await ordersByReference(tx, unrecordedReferences);

		const findings: Finding[] = [];
		let matched = 0;
		let ignored = 0;
		for (const [id, payment] of provider) {
			const row = recorded.get(id);
			const order = !row && payment?.externalReference ? (orders.get(payment.externalReference) ?? null) : null;
			const found = compareOperation({
				provider: payment ? toOperation(payment) : null,
				system: row
					? { providerPaymentId: id, status: row.payment.status, amountMinor: row.payment.amountMinor, currency: row.payment.currency, orderReference: row.reference }
					: null,
				order,
				ownsReference
			});
			if (found.length === 0) {
				if (row) matched++;
				else ignored++;
			}
			if (payment && row && financialsChanged(row.payment, payment)) {
				await tx.update(s.payments).set(providerFinancials(payment)).where(eq(s.payments.id, row.payment.id));
			}
			for (const discrepancy of found) findings.push({ ...discrepancy, orderId: row?.payment.orderId ?? order?.id ?? null });
		}
		await recordFindings(tx, organizationId, runId, findings, now);
		const cleared = await clearSettled(tx, { runId, examined, kinds: operationKinds, current: new Set(findings.map((finding) => finding.fingerprint)), now });
		return { examined: examined.length, matched, ignored, discrepancies: findings.length, cleared };
	});
	return { summary, windowTo };
}

// ─── Settlements ───────────────────────────────────────────────────────────

function reportMessage(error: SettlementReportError): string {
	switch (error.kind) {
		case 'empty':
			return 'El archivo está vacío';
		case 'missing_columns':
			return `No parece el reporte de liquidaciones de Mercado Pago: faltan las columnas ${error.columns.join(', ')}. Generalo con encabezados en inglés`;
		case 'invalid_row':
			return `La fila ${error.line} tiene un valor inválido en ${error.column}`;
	}
}

/**
 * Stores the movements of an uploaded settlement report (idempotent per
 * movement) and compares every payment involved, plus the approved payments
 * that should have been released in the period the report covers.
 */
export async function uploadSettlementReport(
	deps: AppDeps,
	organizationId: string,
	input: { filename: string; content: string; resolver: Resolver }
): Promise<RunOutcome> {
	const parsed = parseSettlementReport(input.content);
	if (!parsed.ok) throw new ApiError(400, 'invalid_report', reportMessage(parsed.error));
	const now = deps.now();
	const times = parsed.rows.map((row) => (row.settledAt ?? row.transactionAt)?.getTime()).filter((time): time is number => time !== undefined);
	const period = times.length > 0 ? { from: new Date(Math.min(...times)), to: new Date(Math.max(...times)) } : { from: now, to: now };

	const runId = await startRun(deps, organizationId, { kind: 'settlements', trigger: 'upload', windowFrom: period.from, windowTo: period.to, startedBy: input.resolver.userId });
	if (!runId) return { status: 'busy' };
	try {
		const summary = await deps.db.withTenant(organizationId, async (tx) => {
			const ownsReference = referenceMatcher(await orderPrefix(tx, organizationId));
			let inserted = 0;
			for (let index = 0; index < parsed.rows.length; index += 1_000) {
				const chunk = parsed.rows.slice(index, index + 1_000).map((row) => ({
					organizationId,
					provider: 'mercadopago',
					runId,
					rowKey: row.rowKey,
					providerPaymentId: row.sourceId,
					externalReference: row.externalReference,
					transactionType: row.transactionType,
					grossMinor: row.grossMinor,
					feeMinor: row.feeMinor,
					netMinor: row.netMinor,
					currency: row.currency,
					transactionAt: row.transactionAt,
					settledAt: row.settledAt,
					createdAt: now
				}));
				inserted += (await tx.insert(s.paymentSettlements).values(chunk).onConflictDoNothing().returning({ id: s.paymentSettlements.id })).length;
			}

			const reported = [...new Set(parsed.rows.map((row) => row.sourceId))];
			const payments = await tx
				.select({ payment: s.payments, reference: s.orders.reference })
				.from(s.payments)
				.innerJoin(s.orders, eq(s.orders.id, s.payments.orderId))
				.where(
					or(
						reported.length > 0 ? inArray(s.payments.providerPaymentId, reported) : undefined,
						and(eq(s.payments.status, 'approved'), gte(s.payments.releaseDate, period.from), lte(s.payments.releaseDate, period.to))
					)
				);
			const examined = [...new Set([...reported, ...payments.map((row) => row.payment.providerPaymentId)])];
			const stored = examined.length > 0 ? await tx.select().from(s.paymentSettlements).where(inArray(s.paymentSettlements.providerPaymentId, examined)) : [];

			const found = compareSettlements({
				rows: stored.map(
					(row): SettlementRow => ({
						sourceId: row.providerPaymentId,
						externalReference: row.externalReference,
						transactionType: row.transactionType,
						grossMinor: row.grossMinor,
						feeMinor: row.feeMinor,
						netMinor: row.netMinor,
						currency: row.currency,
						transactionAt: row.transactionAt,
						settledAt: row.settledAt,
						rowKey: row.rowKey
					})
				),
				payments: payments.map(({ payment, reference }) => ({
					providerPaymentId: payment.providerPaymentId,
					orderReference: reference,
					status: payment.status,
					amountMinor: payment.amountMinor,
					currency: payment.currency,
					netMinor: payment.netMinor,
					releaseDate: payment.releaseDate
				})),
				period,
				ownsReference
			});
			const orderIds = new Map(payments.map(({ payment }) => [payment.providerPaymentId, payment.orderId]));
			const findings = found.map((discrepancy) => ({ ...discrepancy, orderId: orderIds.get(discrepancy.providerPaymentId ?? '') ?? null }));
			await recordFindings(tx, organizationId, runId, findings, now);
			const cleared = await clearSettled(tx, { runId, examined, kinds: settlementOnlyKinds, current: new Set(findings.map((finding) => finding.fingerprint)), now });
			await audit(tx, {
				organizationId,
				actorType: input.resolver.actorType,
				actorId: input.resolver.userId,
				action: 'reconciliation.settlements_uploaded',
				targetType: 'reconciliation_run',
				targetId: runId,
				metadata: { rows: parsed.rows.length, inserted }
			});
			return {
				examined: examined.length,
				discrepancies: findings.length,
				cleared,
				file: { name: input.filename, sha256: sha256Hex(input.content), rows: parsed.rows.length, skipped: parsed.skipped, inserted }
			};
		});
		await finishRun(deps, organizationId, runId, { status: 'completed', summary });
		return { status: 'completed', runId, summary };
	} catch (error) {
		await finishRun(deps, organizationId, runId, { status: 'failed', error: describeFailure(error) });
		throw error;
	}
}

// ─── Resolution ────────────────────────────────────────────────────────────

export interface Resolver {
	readonly userId: string;
	readonly actorType: AuditInput['actorType'];
}

async function openItem(tx: Tx, itemId: string) {
	const [item] = await tx.select().from(s.reconciliationItems).where(eq(s.reconciliationItems.id, itemId)).for('update');
	if (!item) throw notFound('Diferencia');
	if (item.status !== 'open') throw new ApiError(409, 'already_resolved', 'Esta diferencia ya fue resuelta');
	return item;
}

/**
 * Re-reads the payment from the provider and applies it exactly like a
 * webhook would. The item closes only if the difference is gone afterwards;
 * if the provider data still does not match the order, it stays open.
 */
export async function applyProviderState(deps: AppDeps, organizationId: string, itemId: string, resolver: Resolver) {
	const { item, integration } = await deps.db.withTenant(organizationId, async (tx) => ({
		item: await openItem(tx, itemId),
		integration: await loadMercadoPago(tx, organizationId, deps.keyRing)
	}));
	if (!providerStateKinds.includes(item.kind) || !item.providerPaymentId) {
		throw new ApiError(409, 'not_applicable', 'Esta diferencia no se resuelve releyendo el pago. Revisala y aceptala con una nota');
	}
	if (!integration) throw new ApiError(409, 'payments_unavailable', 'La organización no tiene una cuenta de Mercado Pago activa');

	let payment: ProviderPayment;
	try {
		payment = await deps.payments.getPayment(integration.credentials, item.providerPaymentId);
	} catch (error) {
		if (error instanceof ProviderError && error.status === 404) throw new ApiError(409, 'payment_not_found', 'Mercado Pago no encuentra este pago');
		throw new ApiError(503, 'provider_unavailable', 'Mercado Pago no respondió. Probá de nuevo en unos minutos');
	}

	return deps.db.withTenant(organizationId, async (tx) => {
		const locked = await openItem(tx, itemId);
		const now = deps.now();
		const outcome = await applyVerifiedPayment(
			tx,
			{ organizationId, expectedCollectorId: integration.collectorId, pseudonymPepper: deps.config.PSEUDONYM_PEPPER, now },
			payment
		);
		const [row] = await paymentsWithOrders(tx, [payment.id]);
		const order = !row && payment.externalReference ? ((await ordersByReference(tx, [payment.externalReference])).get(payment.externalReference) ?? null) : null;
		const remaining = compareOperation({
			provider: toOperation(payment),
			system: row
				? { providerPaymentId: payment.id, status: row.payment.status, amountMinor: row.payment.amountMinor, currency: row.payment.currency, orderReference: row.reference }
				: null,
			order,
			ownsReference: referenceMatcher(await orderPrefix(tx, organizationId))
		});
		const resolved = !remaining.some((discrepancy) => discrepancy.fingerprint === locked.fingerprint);
		if (resolved) {
			await tx
				.update(s.reconciliationItems)
				.set({
					status: 'resolved',
					resolution: 'provider_state_applied',
					resolutionNote: `Estado de Mercado Pago aplicado: ${outcome}`,
					resolvedBy: resolver.userId,
					resolvedAt: now
				})
				.where(eq(s.reconciliationItems.id, itemId));
		}
		await audit(tx, {
			organizationId,
			actorType: resolver.actorType,
			actorId: resolver.userId,
			action: 'reconciliation.provider_state_applied',
			targetType: 'reconciliation_item',
			targetId: itemId,
			metadata: { kind: locked.kind, providerPaymentId: payment.id, outcome, resolved }
		});
		return { outcome, resolved };
	});
}

/** Records a person's decision that a difference is explained (e.g. a manual refund made outside the platform). */
export async function acceptItem(deps: AppDeps, organizationId: string, itemId: string, note: string, resolver: Resolver) {
	return deps.db.withTenant(organizationId, async (tx) => {
		const item = await openItem(tx, itemId);
		await tx
			.update(s.reconciliationItems)
			.set({ status: 'resolved', resolution: 'accepted', resolutionNote: note, resolvedBy: resolver.userId, resolvedAt: deps.now() })
			.where(eq(s.reconciliationItems.id, itemId));
		await audit(tx, {
			organizationId,
			actorType: resolver.actorType,
			actorId: resolver.userId,
			action: 'reconciliation.accepted',
			targetType: 'reconciliation_item',
			targetId: itemId,
			metadata: { kind: item.kind, providerPaymentId: item.providerPaymentId }
		});
		return { resolved: true };
	});
}

// ─── Schedule ──────────────────────────────────────────────────────────────

/**
 * Runs the operations check for every active organization with a payment
 * account whose last run is older than the interval. Called by the worker.
 */
export async function runDue(deps: AppDeps, intervalMinutes: number) {
	const organizations = await deps.db.withPlatform((db) =>
		db
			.selectDistinct({ id: s.organizations.id })
			.from(s.organizations)
			.innerJoin(
				s.organizationIntegrations,
				and(
					eq(s.organizationIntegrations.organizationId, s.organizations.id),
					eq(s.organizationIntegrations.provider, 'mercadopago'),
					eq(s.organizationIntegrations.isActive, true)
				)
			)
			.where(eq(s.organizations.status, 'active'))
	);
	const dueBefore = new Date(deps.now().getTime() - intervalMinutes * 60_000);
	const results: { organizationId: string; status: 'completed' | 'busy' | 'not_due' | 'failed'; discrepancies?: number }[] = [];
	for (const { id } of organizations) {
		const [last] = await deps.db.withTenant(id, (tx) =>
			tx
				.select({ startedAt: s.reconciliationRuns.startedAt })
				.from(s.reconciliationRuns)
				.where(and(eq(s.reconciliationRuns.kind, 'operations'), gte(s.reconciliationRuns.startedAt, dueBefore)))
				.limit(1)
		);
		if (last) {
			results.push({ organizationId: id, status: 'not_due' });
			continue;
		}
		try {
			const outcome = await runOperations(deps, id, { trigger: 'scheduled' });
			results.push({ organizationId: id, status: outcome.status, discrepancies: outcome.status === 'completed' ? outcome.summary.discrepancies : undefined });
		} catch {
			// The failure is recorded on the run; one organization never blocks the others.
			results.push({ organizationId: id, status: 'failed' });
		}
	}
	return results;
}
