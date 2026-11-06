import { and, count, desc, eq, gte, inArray, isNotNull, lt, lte, or, publishOpsEvent, schema as s, sql, type ReconciliationSummary, type Tx } from '@sortea/db';
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
import { sha256Hex, type KeyRing } from '@sortea/domain/server';
import type { AppDeps } from '../context';
import { audit, type AuditInput } from '../lib/audit';
import { ORDER_TTL_MINUTES } from '../lib/campaign-state';
import { ApiError, notFound } from '../lib/errors';
import { applyVerifiedPayment, providerFinancials } from '../payments/confirm';
import { loadMercadoPagoAccounts, type MercadoPagoAccount } from '../payments/integrations';
import { ORDER_ID, ORDER_SEARCH_PAGE_SIZE, ProviderError, type PaymentProvider, type ProviderCredentials, type ProviderPayment } from '../payments/provider';

/**
 * Reconciliation (FR-PAY-05, AC-09). Runs inside the API because only the API
 * opens the organization's provider credentials (ADR 0004); the worker just
 * calls it on a schedule. Every finding becomes an open item that a person
 * resolves. Nothing here approves a payment: the only way an order changes is
 * the same verified provider read that a webhook triggers.
 *
 * Payments are Mercado Pago orders (ADR 0018), whose search filters by creation
 * date only. A run therefore searches the orders created in its window (what
 * the platform may not know) and re-reads by id the platform's own orders that
 * can still change (what it knows), each with the account it was created with.
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

/** The window's creation dates are searched one day at a time, so a large backlog stops between days. */
const SEARCH_SLICE_MS = 86_400_000;
/** Orders examined per run; a larger backlog continues in the next run. */
const MAX_EXAMINED = 5_000;
/** Re-reads per run of the orders most likely to have changed: open items, payable orders, pending payments, recent changes. */
const MAX_RECHECKS = 200;
/** Re-reads per run of the approved orders within the horizon, taken in turns. */
const HORIZON_RECHECKS = 200;
/**
 * Re-reads per run of the unpaid orders within the late-approval horizon, taken in turns. A budget
 * of their own: they never take slots from the re-reads above.
 */
export const LATE_APPROVAL_RECHECKS = 100;
/**
 * How long after its creation an unpaid order is still re-read for a late approval. The checkout
 * closes after the order TTL, but a payment started before that can be approved much later: a cash
 * ticket (Rapipago, Pago Fácil) is paid until its own due date and credited one or two business days
 * after, and a card payment in manual review is decided within about two business days. Seven days
 * covers both across a weekend or a holiday. An approval later than that is found only if a
 * webhook arrives.
 */
export const LATE_APPROVAL_HORIZON_MS = 7 * 86_400_000;
const OVERLAP_MS = 30 * 60_000;
const FIRST_WINDOW_MS = 3 * 86_400_000;
const MAX_WINDOW_MS = 31 * 86_400_000;
const STALE_RUN_MS = 30 * 60_000;
/**
 * How long a retired account keeps being searched after its last order was
 * created. Refunds and chargebacks reach a payment weeks or months after the
 * purchase, and a lost webhook for one of them is found only by searching the
 * account that took the payment. 180 days is the platform's horizon for those
 * late changes; past it, a retired account's payments are re-read only when the
 * platform touches them or they have an open item (ADR 0017).
 */
export const RETIRED_ACCOUNT_HORIZON_MS = 180 * 86_400_000;

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

/** An account Mercado Pago answers again no longer blocks the reconciliation of its payments. */
async function clearAnsweredAccounts(tx: Tx, input: { runId: string; accountIds: readonly string[]; now: Date }): Promise<number> {
	if (input.accountIds.length === 0) return 0;
	const settled = await tx
		.update(s.reconciliationItems)
		.set({ status: 'resolved', resolution: 'cleared', resolutionNote: 'La conciliación ya no encuentra la diferencia', resolvedAt: input.now, lastRunId: input.runId })
		.where(
			and(
				eq(s.reconciliationItems.status, 'open'),
				eq(s.reconciliationItems.kind, 'account_unavailable'),
				inArray(
					s.reconciliationItems.fingerprint,
					input.accountIds.map((id) => `account_unavailable:${id}`)
				)
			)
		)
		.returning({ id: s.reconciliationItems.id });
	return settled.length;
}

type ProviderIdColumn = typeof s.payments.providerPaymentId | typeof s.orders.providerCheckoutId | typeof s.reconciliationItems.providerPaymentId;

/** Payments stored before the Orders API hold Payments API ids, which are not order ids (ADR 0018). */
const hasOrderId = (column: ProviderIdColumn) => sql`${column} ~ ${ORDER_ID.source}`;

/**
 * A payment stored before the Orders API is kept as history and never re-read: its id is not an
 * order id, so Mercado Pago would answer 404. An item that reported it missing is closed.
 */
async function clearLegacyPayments(tx: Tx, input: { runId: string; now: Date }): Promise<number> {
	const settled = await tx
		.update(s.reconciliationItems)
		.set({
			status: 'resolved',
			resolution: 'cleared',
			resolutionNote: 'Pago anterior a la API de órdenes de Mercado Pago: se conserva como histórico y la conciliación ya no lo relee',
			resolvedAt: input.now,
			lastRunId: input.runId
		})
		.where(
			and(
				eq(s.reconciliationItems.status, 'open'),
				eq(s.reconciliationItems.kind, 'payment_missing_at_provider'),
				isNotNull(s.reconciliationItems.providerPaymentId),
				sql`not (${hasOrderId(s.reconciliationItems.providerPaymentId)})`
			)
		)
		.returning({ id: s.reconciliationItems.id });
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

// ─── Accounts ──────────────────────────────────────────────────────────────

/** Mercado Pago refused the credentials themselves; outages and rate limits are not this. */
export function refusesCredentials(error: unknown): error is ProviderError {
	return error instanceof ProviderError && (error.status === 400 || error.status === 401 || error.status === 403);
}

/**
 * Accounts with orders created within the horizon before a window ends.
 * Besides the active account, only these are searched for the window's
 * payments, late refunds and chargebacks included (S2).
 */
export async function accountsWithOrders(tx: Tx, window: { to: Date }): Promise<Set<string>> {
	const since = new Date(window.to.getTime() - RETIRED_ACCOUNT_HORIZON_MS);
	const rows = await tx
		.selectDistinct({ id: s.orders.paymentIntegrationId })
		.from(s.orders)
		.where(and(isNotNull(s.orders.paymentIntegrationId), gte(s.orders.createdAt, since)));
	return new Set(rows.map((row) => row.id!));
}

interface PaymentOwner {
	readonly integrationId: string | null;
	readonly collectorId: string | null;
}

/** The account of each payment's order, from the platform's payments, orders and open items. */
async function paymentOwners(tx: Tx, providerPaymentIds: readonly string[]): Promise<Map<string, PaymentOwner>> {
	const owners = new Map<string, PaymentOwner>();
	if (providerPaymentIds.length === 0) return owners;
	const items = await tx
		.select({ id: s.reconciliationItems.providerPaymentId, integrationId: s.orders.paymentIntegrationId })
		.from(s.reconciliationItems)
		.innerJoin(s.orders, eq(s.orders.id, s.reconciliationItems.orderId))
		.where(inArray(s.reconciliationItems.providerPaymentId, [...providerPaymentIds]));
	for (const row of items) owners.set(row.id!, { integrationId: row.integrationId, collectorId: null });
	const placed = await tx
		.select({ id: s.orders.providerCheckoutId, integrationId: s.orders.paymentIntegrationId })
		.from(s.orders)
		.where(inArray(s.orders.providerCheckoutId, [...providerPaymentIds]));
	for (const row of placed) owners.set(row.id!, { integrationId: row.integrationId, collectorId: null });
	const recorded = await tx
		.select({ id: s.payments.providerPaymentId, integrationId: s.orders.paymentIntegrationId, collectorId: s.payments.collectorId })
		.from(s.payments)
		.innerJoin(s.orders, eq(s.orders.id, s.payments.orderId))
		.where(inArray(s.payments.providerPaymentId, [...providerPaymentIds]));
	for (const row of recorded) owners.set(row.id, { integrationId: row.integrationId, collectorId: row.collectorId });
	return owners;
}

/**
 * The account a payment is read with: its order's account; for orders created
 * before accounts were recorded, the account of the payment's merchant; else the active one.
 */
function accountFor(accounts: readonly MercadoPagoAccount[], owner: PaymentOwner | undefined): MercadoPagoAccount | null {
	const own = owner?.integrationId ? accounts.find((account) => account.id === owner.integrationId) : undefined;
	const merchant = owner?.collectorId ? accounts.find((account) => account.collectorId === owner.collectorId) : undefined;
	return own ?? merchant ?? accounts.find((account) => account.isActive) ?? null;
}

/** The organization's accounts; reconciliation needs an active one. */
async function organizationAccounts(tx: Tx, organizationId: string, keyRing: KeyRing): Promise<MercadoPagoAccount[]> {
	const accounts = await loadMercadoPagoAccounts(tx, organizationId, keyRing);
	if (!accounts.some((account) => account.isActive)) throw new ApiError(409, 'payments_unavailable', 'La organización no tiene una cuenta de Mercado Pago activa');
	return accounts;
}

/**
 * The `budget` ids of a list ordered by id that are this run's turn: each run starts where the
 * previous one stopped and wraps around, so each id comes up about once every ceil(total / budget)
 * runs. Ids entering or leaving the list between runs shift the positions, so that is typical, not a bound.
 */
async function takeTurn(runs: number, budget: number, total: number, page: (offset: number, limit: number) => Promise<{ id: string | null }[]>): Promise<string[]> {
	if (total === 0) return [];
	const start = (runs * budget) % total;
	const rows = await page(start, budget);
	// The turn wraps around to the first ids.
	if (rows.length < budget && start > 0) rows.push(...(await page(0, Math.min(start, budget - rows.length))));
	return rows.map((row) => row.id!);
}

/**
 * The platform's orders to re-read by id in a run, besides those the search already returned:
 * - first, up to MAX_RECHECKS of: payments with an open item; orders that could still be paid in
 *   the window (a lost approval); payments still pending or in process within the horizon; and
 *   payments the platform touched in the window;
 * - then up to HORIZON_RECHECKS approved payments within the horizon, which can still be refunded
 *   or charged back. They are taken in turns, by id, so each is re-read about once every
 *   ceil(approved / HORIZON_RECHECKS) runs;
 * - then up to LATE_APPROVAL_RECHECKS unpaid orders created within the late-approval horizon,
 *   whose approval can land long after their expiry (cash tickets, manual reviews) even when every
 *   webhook was lost. Also in turns, by id.
 * Refunded and charged-back payments, those older than the horizon, and payments stored before the
 * Orders API (whose ids are not order ids, ADR 0018) are not re-read.
 */
async function recheckCandidates(tx: Tx, window: { from: Date; to: Date }, known: ReadonlyMap<string, unknown>) {
	const since = new Date(window.to.getTime() - RETIRED_ACCOUNT_HORIZON_MS);
	const open = await tx
		.select({ id: s.reconciliationItems.providerPaymentId })
		.from(s.reconciliationItems)
		.where(
			and(
				eq(s.reconciliationItems.status, 'open'),
				inArray(s.reconciliationItems.kind, [...operationKinds]),
				isNotNull(s.reconciliationItems.providerPaymentId),
				hasOrderId(s.reconciliationItems.providerPaymentId)
			)
		);
	const unpaid = and(isNotNull(s.orders.providerCheckoutId), hasOrderId(s.orders.providerCheckoutId), inArray(s.orders.status, ['pending_payment', 'payment_failed', 'expired']));
	const payable = await tx
		.select({ id: s.orders.providerCheckoutId })
		.from(s.orders)
		.where(and(unpaid, gte(s.orders.expiresAt, window.from), lte(s.orders.createdAt, window.to)));
	const unsettled = await tx
		.select({ id: s.payments.providerPaymentId })
		.from(s.payments)
		.where(and(inArray(s.payments.status, ['pending', 'in_process']), gte(s.payments.createdAt, since), hasOrderId(s.payments.providerPaymentId)));
	const touched = await tx
		.select({ id: s.payments.providerPaymentId })
		.from(s.payments)
		.where(and(gte(s.payments.updatedAt, window.from), lte(s.payments.updatedAt, window.to), hasOrderId(s.payments.providerPaymentId)));
	const priority = [...new Set([...open, ...payable, ...unsettled, ...touched].map((row) => row.id!))].filter((id) => !known.has(id)).slice(0, MAX_RECHECKS);
	const taken = new Set(priority);

	const [completed] = await tx
		.select({ value: count() })
		.from(s.reconciliationRuns)
		.where(and(eq(s.reconciliationRuns.kind, 'operations'), eq(s.reconciliationRuns.status, 'completed')));
	const runs = completed?.value ?? 0;

	const approved = and(
		eq(s.payments.status, 'approved'),
		sql`coalesce(${s.payments.approvedAt}, ${s.payments.createdAt}) >= ${since.toISOString()}::timestamptz`,
		hasOrderId(s.payments.providerPaymentId)
	);
	const [approvedCount] = await tx.select({ value: count() }).from(s.payments).where(approved);
	const inTurn = (
		await takeTurn(runs, HORIZON_RECHECKS, approvedCount?.value ?? 0, (offset, limit) =>
			tx.select({ id: s.payments.providerPaymentId }).from(s.payments).where(approved).orderBy(s.payments.providerPaymentId).offset(offset).limit(limit)
		)
	).filter((id) => !known.has(id) && !taken.has(id));
	for (const id of inTurn) taken.add(id);

	const late = and(unpaid, gte(s.orders.createdAt, new Date(window.to.getTime() - LATE_APPROVAL_HORIZON_MS)));
	const [lateCount] = await tx.select({ value: count() }).from(s.orders).where(late);
	const lateTurn = (
		await takeTurn(runs, LATE_APPROVAL_RECHECKS, lateCount?.value ?? 0, (offset, limit) =>
			tx.select({ id: s.orders.providerCheckoutId }).from(s.orders).where(late).orderBy(s.orders.providerCheckoutId).offset(offset).limit(limit)
		)
	).filter((id) => !known.has(id) && !taken.has(id));

	const ids = [...priority, ...inTurn, ...lateTurn];
	return { ids, owners: await paymentOwners(tx, ids) };
}

// ─── Operations ────────────────────────────────────────────────────────────

/**
 * The pages of one orders search, each with the orders it brings. Paging stops at the stated total
 * or on an empty page, and also when a page brings no order this search has not already returned,
 * or after MAX_EXAMINED orders' worth of pages: a provider that ignored the offset and stated no
 * total would otherwise be asked for the same page forever.
 */
export async function* searchOrderPages(
	payments: PaymentProvider,
	credentials: ProviderCredentials,
	range: { createdFrom: Date; createdTo: Date }
): AsyncGenerator<readonly ProviderPayment[]> {
	const seen = new Set<string>();
	for (let offset = 0, pages = 0; pages < MAX_EXAMINED / ORDER_SEARCH_PAGE_SIZE; pages++) {
		const page = await payments.searchOrders(credentials, { ...range, offset, limit: ORDER_SEARCH_PAGE_SIZE });
		const fresh = page.results.filter((order) => !seen.has(order.id));
		if (fresh.length === 0) return;
		for (const order of fresh) seen.add(order.id);
		yield page.results;
		offset += page.results.length;
		if (offset >= page.total) return;
	}
}

/**
 * Compares the provider's orders with the platform's payments: the orders created in the
 * window, and the platform's orders that can still change, re-read one by one, so a payment
 * missing at the provider is found too.
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
			accounts: await organizationAccounts(tx, organizationId, deps.keyRing),
			prefix: await orderPrefix(tx, organizationId),
			lastWindowTo: last?.windowTo ?? null
		};
	});

	const to = options.to ?? deps.now();
	let from = options.from ?? (setup.lastWindowTo ? new Date(setup.lastWindowTo.getTime() - OVERLAP_MS) : new Date(to.getTime() - FIRST_WINDOW_MS));
	if (to.getTime() - from.getTime() > MAX_WINDOW_MS) from = new Date(to.getTime() - MAX_WINDOW_MS);
	if (from >= to) throw new ApiError(400, 'invalid_window', 'El inicio del período tiene que ser anterior al fin');
	// The active account, and every previous account with orders within the horizon.
	const used = await deps.db.withTenant(organizationId, (tx) => accountsWithOrders(tx, { to }));
	const searched = setup.accounts.filter((account) => account.isActive || used.has(account.id));

	const runId = await startRun(deps, organizationId, { kind: 'operations', trigger: options.trigger, windowFrom: from, windowTo: to, startedBy: options.startedBy ?? null });
	if (!runId) return { status: 'busy' };
	try {
		const { summary, windowTo } = await examineOperations(deps, organizationId, { all: setup.accounts, searched }, runId, { from, to }, referenceMatcher(setup.prefix));
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
	accounts: { all: readonly MercadoPagoAccount[]; searched: readonly MercadoPagoAccount[] },
	runId: string,
	window: { from: Date; to: Date },
	ownsReference: (reference: string) => boolean
): Promise<{ summary: ReconciliationSummary; windowTo: Date }> {
	const now = deps.now();
	// Orders of every account merged by id, so none is counted twice.
	const provider = new Map<string, ProviderPayment | null>();
	// Previous accounts whose credentials Mercado Pago refuses, with the HTTP status.
	const refused = new Map<string, number | null>();
	let windowTo = window.to;

	// 1. What the platform may not know: the orders created in the window, or early enough to
	// be paid in it. Every searched account is asked, which also tells whether it still answers.
	const createdFrom = new Date(window.from.getTime() - ORDER_TTL_MINUTES * 60_000);
	for (let sliceFrom = createdFrom; sliceFrom < window.to; ) {
		const sliceTo = new Date(Math.min(sliceFrom.getTime() + SEARCH_SLICE_MS, window.to.getTime()));
		for (const account of accounts.searched) {
			if (refused.has(account.id)) continue;
			try {
				for await (const orders of searchOrderPages(deps.payments, account.credentials, { createdFrom: sliceFrom, createdTo: sliceTo })) {
					for (const order of orders) provider.set(order.id, order);
				}
			} catch (error) {
				if (account.isActive || !refusesCredentials(error)) throw error;
				refused.set(account.id, error.status);
			}
		}
		sliceFrom = sliceTo;
		// The search states no order of its results, so a backlog stops between slices and the next run continues there.
		if (provider.size >= MAX_EXAMINED && sliceTo < window.to) {
			windowTo = sliceTo;
			break;
		}
	}

	// 2. What the platform knows and can still change (late approvals, refunds, chargebacks):
	// re-read one by one, each with its order's account.
	const toRecheck = await deps.db.withTenant(organizationId, (tx) => recheckCandidates(tx, { from: window.from, to: windowTo }, provider));
	for (const id of toRecheck.ids) {
		// A refused account's orders wait for it.
		const account = accountFor(accounts.all, toRecheck.owners.get(id));
		if (!account || refused.has(account.id)) continue;
		try {
			provider.set(id, await deps.payments.getOrder(account.credentials, id));
		} catch (error) {
			if (error instanceof ProviderError && error.status === 404) provider.set(id, null);
			else if (!account.isActive && refusesCredentials(error)) refused.set(account.id, error.status);
			else throw error;
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
		for (const [accountId, status] of refused) {
			const account = accounts.all.find((candidate) => candidate.id === accountId)!;
			findings.push({
				kind: 'account_unavailable',
				severity: 'critical',
				providerPaymentId: null,
				orderReference: null,
				expected: { collectorId: account.collectorId, mode: account.mode },
				observed: { status },
				fingerprint: `account_unavailable:${account.id}`,
				orderId: null
			});
		}
		await recordFindings(tx, organizationId, runId, findings, now);
		const answered = accounts.searched.filter((account) => !refused.has(account.id)).map((account) => account.id);
		const cleared =
			(await clearSettled(tx, { runId, examined, kinds: operationKinds, current: new Set(findings.map((finding) => finding.fingerprint)), now })) +
			(await clearAnsweredAccounts(tx, { runId, accountIds: answered, now })) +
			(await clearLegacyPayments(tx, { runId, now }));
		if (findings.length > 0 || cleared > 0) await publishOpsEvent(tx, organizationId, 'reconciliation.updated');
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
			const references = [...new Set(parsed.rows.map((row) => row.externalReference).filter((reference): reference is string => reference !== null))];
			const payments = await tx
				.select({ payment: s.payments, reference: s.orders.reference })
				.from(s.payments)
				.innerJoin(s.orders, eq(s.orders.id, s.payments.orderId))
				.where(
					or(
						reported.length > 0 ? inArray(s.payments.providerPaymentId, reported) : undefined,
						references.length > 0 ? inArray(s.orders.reference, references) : undefined,
						and(eq(s.payments.status, 'approved'), gte(s.payments.releaseDate, period.from), lte(s.payments.releaseDate, period.to))
					)
				);
			const examined = [...new Set([...reported, ...payments.map((row) => row.payment.providerPaymentId)])];
			// A movement names Mercado Pago's numeric payment id, while the platform stores the order id
			// (ADR 0018): a movement whose id the platform does not store is matched by its order reference.
			const storedIds = new Set(payments.map(({ payment }) => payment.providerPaymentId));
			const idByReference = new Map(payments.map(({ payment, reference }) => [reference, payment.providerPaymentId]));
			const stored =
				examined.length > 0
					? await tx
							.select()
							.from(s.paymentSettlements)
							.where(
								or(
									inArray(s.paymentSettlements.providerPaymentId, examined),
									idByReference.size > 0 ? inArray(s.paymentSettlements.externalReference, [...idByReference.keys()]) : undefined
								)
							)
					: [];
			const paymentIdOf = (row: (typeof stored)[number]) =>
				storedIds.has(row.providerPaymentId) ? row.providerPaymentId : ((row.externalReference && idByReference.get(row.externalReference)) ?? row.providerPaymentId);

			const found = compareSettlements({
				rows: stored.map(
					(row): SettlementRow => ({
						sourceId: paymentIdOf(row),
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
			if (findings.length > 0 || cleared > 0) await publishOpsEvent(tx, organizationId, 'reconciliation.updated');
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
	const { item, integration } = await deps.db.withTenant(organizationId, async (tx) => {
		const item = await openItem(tx, itemId);
		const accounts = await loadMercadoPagoAccounts(tx, organizationId, deps.keyRing);
		const owners = await paymentOwners(tx, item.providerPaymentId ? [item.providerPaymentId] : []);
		// The payment is read with the account of its order (S2).
		return { item, integration: accountFor(accounts, owners.get(item.providerPaymentId ?? '')) };
	});
	if (!providerStateKinds.includes(item.kind) || !item.providerPaymentId) {
		throw new ApiError(409, 'not_applicable', 'Esta diferencia no se resuelve releyendo el pago. Revisala y aceptala con una nota');
	}
	if (!integration) throw new ApiError(409, 'payments_unavailable', 'La organización no tiene una cuenta de Mercado Pago activa');

	let payment: ProviderPayment;
	try {
		payment = await deps.payments.getOrder(integration.credentials, item.providerPaymentId);
	} catch (error) {
		if (error instanceof ProviderError && error.status === 404) throw new ApiError(409, 'payment_not_found', 'Mercado Pago no encuentra este pago');
		if (!integration.isActive && refusesCredentials(error)) {
			throw new ApiError(409, 'account_unavailable', 'Mercado Pago rechaza las credenciales de la cuenta anterior que cobró este pago');
		}
		throw new ApiError(503, 'provider_unavailable', 'Mercado Pago no respondió. Probá de nuevo en unos minutos');
	}

	return deps.db.withTenant(organizationId, async (tx) => {
		const locked = await openItem(tx, itemId);
		const now = deps.now();
		const outcome = await applyVerifiedPayment(
			tx,
			{
				organizationId,
				paymentAccountId: integration.id,
				expectedCollectorId: integration.collectorId,
				pseudonymPepper: deps.config.PSEUDONYM_PEPPER,
				complianceDemo: deps.config.COMPLIANCE_DEMO,
				now
			},
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
		await publishOpsEvent(tx, organizationId, 'reconciliation.updated', itemId);
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
		await publishOpsEvent(tx, organizationId, 'reconciliation.updated', itemId);
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
