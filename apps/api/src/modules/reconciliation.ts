import { and, count, desc, eq, gte, isNotNull, lte, schema as s, sql, type SQL } from '@sortea/db';
import { discrepancyKinds, mapMercadoPagoStatus, minorToDecimal, providerStateKinds, toCsv, type CsvCell } from '@sortea/domain';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { actorType, requireAdmin, type AdminContext } from '../lib/admin-context';
import { audit } from '../lib/audit';
import { ApiError, parse } from '../lib/errors';
import { requireMercadoPago } from '../payments/integrations';
import type { ProviderPayment } from '../payments/provider';
import { acceptItem, applyProviderState, runDue, runOperations, uploadSettlementReport, type Resolver, type RunOutcome } from '../reconciliation/engine';

const DAY_MS = 86_400_000;
const MAX_EXPORT_DAYS = 93;
const MAX_PROVIDER_EXPORT = 5_000;

const periodQuery = z
	.object({ from: z.coerce.date().optional(), to: z.coerce.date().optional() })
	.refine((value) => !value.from || !value.to || value.from < value.to, { message: 'El inicio tiene que ser anterior al fin', path: ['from'] });

const itemsQuery = z.object({
	status: z.enum(['open', 'resolved']).default('open'),
	kind: z.enum(discrepancyKinds).optional(),
	page: z.coerce.number().int().min(1).max(500).default(1)
});

const runBody = z
	.object({ from: z.coerce.date().optional(), to: z.coerce.date().optional() })
	.refine((value) => !value.from || !value.to || value.from < value.to, { message: 'El inicio tiene que ser anterior al fin', path: ['from'] });

const uploadBody = z.object({
	filename: z.string().trim().min(1).max(200),
	content: z.string().min(1).max(8 * 1024 * 1024)
});

const resolveBody = z.discriminatedUnion('action', [
	z.object({ action: z.literal('apply_provider_state') }),
	z.object({ action: z.literal('accept'), note: z.string().trim().min(10, 'Explicá en al menos 10 caracteres por qué se acepta').max(1000) })
]);

const exportParams = z.object({ source: z.enum(['system', 'provider', 'settlements', 'items']) });

function resolver(admin: AdminContext): Resolver {
	return { userId: admin.identity.userId, actorType: actorType(admin) };
}

function runResponse(outcome: RunOutcome) {
	if (outcome.status === 'busy') throw new ApiError(409, 'run_in_progress', 'Ya hay una conciliación en curso. Esperá a que termine');
	return outcome;
}

/** Default reporting window: the last 30 days, capped for exports. */
function exportPeriod(query: { from?: Date; to?: Date }, now: Date) {
	const to = query.to ?? now;
	const from = query.from ?? new Date(to.getTime() - 30 * DAY_MS);
	if (to.getTime() - from.getTime() > MAX_EXPORT_DAYS * DAY_MS) {
		throw new ApiError(400, 'period_too_long', `Exportá como máximo ${MAX_EXPORT_DAYS} días por archivo`);
	}
	return { from, to };
}

const amount = (minor: number | null | undefined): CsvCell => (minor === null || minor === undefined ? null : minorToDecimal(minor));
const iso = (date: Date | null | undefined): CsvCell => date?.toISOString() ?? null;

export async function reconciliationRoutes(app: FastifyInstance) {
	const { deps } = app;

	/** Finance view (FR-PAY-06): gross, fees, reversals, estimated net and credited money, never inferred from sales. */
	app.get('/admin/reconciliation', async (request) => {
		const admin = await requireAdmin(request, 'finance.view');
		const query = parse(periodQuery, request.query);
		return deps.db.withTenant(admin.tenant.id, async (tx) => {
			const approvedIn: SQL[] = [isNotNull(s.payments.approvedAt)];
			if (query.from) approvedIn.push(gte(s.payments.approvedAt, query.from));
			if (query.to) approvedIn.push(lte(s.payments.approvedAt, query.to));
			const settledAt = sql`coalesce(${s.paymentSettlements.settledAt}, ${s.paymentSettlements.transactionAt})`;
			const settledIn: SQL[] = [];
			if (query.from) settledIn.push(sql`${settledAt} >= ${query.from.toISOString()}::timestamptz`);
			if (query.to) settledIn.push(sql`${settledAt} <= ${query.to.toISOString()}::timestamptz`);

			const [[money], [settled], openCounts, runs] = await Promise.all([
				tx
					.select({
						gross: sql<string>`coalesce(sum(${s.payments.amountMinor}), 0)`,
						fees: sql<string>`coalesce(sum(${s.payments.feeMinor}), 0)`,
						feesUnknown: sql<number>`count(*) filter (where ${s.payments.feeMinor} is null)::int`,
						reversed: sql<string>`coalesce(sum(case when ${s.payments.status} in ('refunded', 'charged_back') then ${s.payments.amountMinor} else ${s.payments.refundedMinor} end), 0)`,
						net: sql<string>`coalesce(sum(${s.payments.netMinor} - ${s.payments.refundedMinor}) filter (where ${s.payments.status} = 'approved'), 0)`,
						netUnknown: sql<number>`count(*) filter (where ${s.payments.status} = 'approved' and ${s.payments.netMinor} is null)::int`,
						payments: count()
					})
					.from(s.payments)
					.where(and(...approvedIn)),
				tx
					.select({ credited: sql<string>`coalesce(sum(${s.paymentSettlements.netMinor}), 0)`, movements: count() })
					.from(s.paymentSettlements)
					.where(settledIn.length > 0 ? and(...settledIn) : undefined),
				tx
					.select({ severity: s.reconciliationItems.severity, value: count() })
					.from(s.reconciliationItems)
					.where(eq(s.reconciliationItems.status, 'open'))
					.groupBy(s.reconciliationItems.severity),
				tx.select().from(s.reconciliationRuns).orderBy(desc(s.reconciliationRuns.startedAt)).limit(10)
			]);
			return {
				currency: admin.tenant.currency,
				period: { from: query.from ?? null, to: query.to ?? null },
				finance: {
					grossMinor: Number(money?.gross ?? 0),
					feesMinor: Number(money?.fees ?? 0),
					feesUnknown: money?.feesUnknown ?? 0,
					reversedMinor: Number(money?.reversed ?? 0),
					netEstimatedMinor: Number(money?.net ?? 0),
					netUnknown: money?.netUnknown ?? 0,
					payments: money?.payments ?? 0,
					creditedMinor: Number(settled?.credited ?? 0),
					settlementMovements: settled?.movements ?? 0,
					// Not inferred from sales (FR-PAY-06): only the provider can state these.
					availableMinor: null,
					payoutsMinor: null
				},
				open: {
					critical: openCounts.find((row) => row.severity === 'critical')?.value ?? 0,
					warning: openCounts.find((row) => row.severity === 'warning')?.value ?? 0
				},
				runs: runs.map((run) => ({
					id: run.id,
					kind: run.kind,
					trigger: run.trigger,
					status: run.status,
					windowFrom: run.windowFrom,
					windowTo: run.windowTo,
					startedAt: run.startedAt,
					finishedAt: run.finishedAt,
					summary: run.summary,
					error: run.error
				})),
				canReconcile: admin.permissions.includes('finance.reconcile')
			};
		});
	});

	app.get('/admin/reconciliation/items', async (request) => {
		const admin = await requireAdmin(request, 'finance.view');
		const query = parse(itemsQuery, request.query);
		const pageSize = 25;
		return deps.db.withTenant(admin.tenant.id, async (tx) => {
			const filters = and(eq(s.reconciliationItems.status, query.status), query.kind ? eq(s.reconciliationItems.kind, query.kind) : undefined);
			const [rows, [total]] = await Promise.all([
				tx
					.select()
					.from(s.reconciliationItems)
					.where(filters)
					.orderBy(sql`${s.reconciliationItems.severity} = 'critical' desc`, desc(s.reconciliationItems.lastSeenAt))
					.limit(pageSize)
					.offset((query.page - 1) * pageSize),
				tx.select({ value: count() }).from(s.reconciliationItems).where(filters)
			]);
			return {
				items: rows.map((item) => ({
					id: item.id,
					kind: item.kind,
					severity: item.severity,
					status: item.status,
					providerPaymentId: item.providerPaymentId,
					orderReference: item.orderReference,
					orderId: item.orderId,
					expected: item.expected,
					observed: item.observed,
					firstSeenAt: item.firstSeenAt,
					lastSeenAt: item.lastSeenAt,
					resolution: item.resolution,
					resolutionNote: item.resolutionNote,
					resolvedAt: item.resolvedAt,
					canApplyProviderState: item.status === 'open' && providerStateKinds.includes(item.kind)
				})),
				page: query.page,
				pageSize,
				total: total?.value ?? 0
			};
		});
	});

	app.post('/admin/reconciliation/runs', async (request) => {
		const admin = await requireAdmin(request, 'finance.reconcile');
		const body = parse(runBody, request.body ?? {});
		return runResponse(await runOperations(deps, admin.tenant.id, { trigger: 'manual', from: body.from, to: body.to, startedBy: admin.identity.userId }));
	});

	app.post('/admin/reconciliation/settlements', { bodyLimit: 10 * 1024 * 1024 }, async (request) => {
		const admin = await requireAdmin(request, 'finance.reconcile');
		const body = parse(uploadBody, request.body);
		return runResponse(await uploadSettlementReport(deps, admin.tenant.id, { filename: body.filename, content: body.content, resolver: resolver(admin) }));
	});

	app.post('/admin/reconciliation/items/:id/resolve', async (request) => {
		const admin = await requireAdmin(request, 'finance.reconcile');
		const { id } = parse(z.object({ id: z.uuid() }), request.params);
		const body = parse(resolveBody, request.body);
		return body.action === 'accept'
			? acceptItem(deps, admin.tenant.id, id, body.note, resolver(admin))
			: applyProviderState(deps, admin.tenant.id, id, resolver(admin));
	});

	/** CSV exports of both sides (FR-PAY-05). They carry no buyer data. */
	app.get('/admin/reconciliation/export/:source', async (request, reply) => {
		const admin = await requireAdmin(request, 'finance.view');
		const { source } = parse(exportParams, request.params);
		const period = exportPeriod(parse(periodQuery, request.query), deps.now());
		const csv = await exportCsv(source, admin, period);
		await deps.db.withTenant(admin.tenant.id, (tx) =>
			audit(tx, {
				organizationId: admin.tenant.id,
				actorType: actorType(admin),
				actorId: admin.identity.userId,
				action: 'reconciliation.exported',
				targetType: 'organization',
				targetId: admin.tenant.id,
				metadata: { source, from: period.from.toISOString(), to: period.to.toISOString() }
			})
		);
		const day = (date: Date) => date.toISOString().slice(0, 10);
		return reply
			.header('content-type', 'text/csv; charset=utf-8')
			.header('content-disposition', `attachment; filename="conciliacion-${source}-${day(period.from)}-${day(period.to)}.csv"`)
			.header('cache-control', 'no-store')
			.send(csv);
	});

	async function exportCsv(source: z.infer<typeof exportParams>['source'], admin: AdminContext, period: { from: Date; to: Date }): Promise<string> {
		if (source === 'provider') {
			const integration = await deps.db.withTenant(admin.tenant.id, (tx) => requireMercadoPago(tx, admin.tenant.id, deps.keyRing));
			const payments: ProviderPayment[] = [];
			for (let offset = 0; payments.length < MAX_PROVIDER_EXPORT; ) {
				const page = await deps.payments.searchPayments(integration.credentials, { updatedFrom: period.from, updatedTo: period.to, offset, limit: 100 });
				payments.push(...page.results);
				offset += page.results.length;
				if (page.results.length === 0 || offset >= page.total) break;
			}
			return toCsv(
				['provider_payment_id', 'external_reference', 'status', 'mapped_status', 'amount', 'currency', 'refunded', 'fee', 'net', 'approved_at', 'release_date', 'release_status', 'updated_at'],
				payments.map((payment) => [
					payment.id,
					payment.externalReference,
					payment.status,
					mapMercadoPagoStatus(payment.status),
					amount(payment.amountMinor),
					payment.currency,
					amount(payment.refundedMinor),
					amount(payment.feeMinor),
					amount(payment.netMinor),
					iso(payment.approvedAt),
					iso(payment.releaseDate),
					payment.releaseStatus,
					iso(payment.updatedAt)
				])
			);
		}
		return deps.db.withTenant(admin.tenant.id, async (tx) => {
			if (source === 'system') {
				const at = sql`coalesce(${s.payments.approvedAt}, ${s.payments.updatedAt})`;
				const rows = await tx
					.select({ payment: s.payments, reference: s.orders.reference, orderStatus: s.orders.status })
					.from(s.payments)
					.innerJoin(s.orders, eq(s.orders.id, s.payments.orderId))
					.where(and(sql`${at} >= ${period.from.toISOString()}::timestamptz`, sql`${at} <= ${period.to.toISOString()}::timestamptz`))
					.orderBy(at);
				return toCsv(
					['provider_payment_id', 'order_reference', 'order_status', 'status', 'status_detail', 'amount', 'currency', 'refunded', 'fee', 'net', 'approved_at', 'release_date', 'release_status', 'updated_at'],
					rows.map(({ payment, reference, orderStatus }) => [
						payment.providerPaymentId,
						reference,
						orderStatus,
						payment.status,
						payment.statusDetail,
						amount(payment.amountMinor),
						payment.currency,
						amount(payment.refundedMinor),
						amount(payment.feeMinor),
						amount(payment.netMinor),
						iso(payment.approvedAt),
						iso(payment.releaseDate),
						payment.releaseStatus,
						iso(payment.updatedAt)
					])
				);
			}
			if (source === 'settlements') {
				const at = sql`coalesce(${s.paymentSettlements.settledAt}, ${s.paymentSettlements.transactionAt})`;
				const rows = await tx
					.select()
					.from(s.paymentSettlements)
					.where(and(sql`${at} >= ${period.from.toISOString()}::timestamptz`, sql`${at} <= ${period.to.toISOString()}::timestamptz`))
					.orderBy(at);
				return toCsv(
					['provider_payment_id', 'external_reference', 'transaction_type', 'gross', 'fee', 'net', 'currency', 'transaction_at', 'settled_at', 'uploaded_at'],
					rows.map((row) => [
						row.providerPaymentId,
						row.externalReference,
						row.transactionType,
						amount(row.grossMinor),
						amount(row.feeMinor),
						amount(row.netMinor),
						row.currency,
						iso(row.transactionAt),
						iso(row.settledAt),
						iso(row.createdAt)
					])
				);
			}
			const rows = await tx
				.select()
				.from(s.reconciliationItems)
				.where(and(gte(s.reconciliationItems.lastSeenAt, period.from), lte(s.reconciliationItems.firstSeenAt, period.to)))
				.orderBy(s.reconciliationItems.firstSeenAt);
			return toCsv(
				['id', 'kind', 'severity', 'status', 'provider_payment_id', 'order_reference', 'expected', 'observed', 'first_seen_at', 'last_seen_at', 'resolution', 'resolution_note', 'resolved_at'],
				rows.map((item) => [
					item.id,
					item.kind,
					item.severity,
					item.status,
					item.providerPaymentId,
					item.orderReference,
					JSON.stringify(item.expected),
					JSON.stringify(item.observed),
					iso(item.firstSeenAt),
					iso(item.lastSeenAt),
					item.resolution,
					item.resolutionNote,
					iso(item.resolvedAt)
				])
			);
		});
	}

	/** Scheduled entry point, reachable only with the internal token (the worker's clock). */
	app.post('/internal/reconciliation/run-due', async (request) => {
		const { intervalMinutes } = parse(z.object({ intervalMinutes: z.number().int().min(5).max(1440).default(30) }), request.body ?? {});
		return { results: await runDue(deps, intervalMinutes) };
	});
}
