import { and, desc, eq, publishOpsEvent, schema as s, type Tx } from '@sortea/db';
import { expenseInputSchema, expensePatchSchema, type ExpenseInput } from '@sortea/domain';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { actorType, requireAdmin, type AdminContext } from '../lib/admin-context';
import { audit } from '../lib/audit';
import { notFound, parse } from '../lib/errors';

/**
 * Expenses charged to a campaign (odd/tasks/campaign-finance.md S2, S4, S6; ADR 0025). Everyone
 * who sees the overview reads them; the owner and the finance manager load, edit and delete them
 * (`finance.expenses`). Every change is audited and publishes the change notice the live overview
 * listens to. Expenses stay editable on archived campaigns: the recount happens at the end.
 */
const campaignParams = z.object({ id: z.uuid() });
const expenseParams = z.object({ id: z.uuid(), expenseId: z.uuid() });

type ExpenseRow = typeof s.campaignExpenses.$inferSelect;

/** Fields the audit compares before and after an edit; the free detail only shows as changed. */
const auditedFields = ['category', 'amountMinor', 'spentOn'] as const;

function expenseView(expense: ExpenseRow) {
	return {
		id: expense.id,
		category: expense.category,
		detail: expense.detail,
		amountMinor: expense.amountMinor,
		currency: expense.currency,
		spentOn: expense.spentOn,
		createdAt: expense.createdAt,
		updatedAt: expense.updatedAt
	};
}

/** The detail is free text and may name people, so the audit keeps only the amounts and the category. */
function auditSummary(expense: ExpenseRow) {
	return { expenseId: expense.id, category: expense.category, amountMinor: expense.amountMinor, spentOn: expense.spentOn };
}

async function loadCampaign(tx: Tx, id: string) {
	const [campaign] = await tx.select({ id: s.campaigns.id, title: s.campaigns.title, status: s.campaigns.status }).from(s.campaigns).where(eq(s.campaigns.id, id));
	if (!campaign) throw notFound('Campaña');
	return campaign;
}

async function loadExpense(tx: Tx, campaignId: string, expenseId: string, lock = false) {
	const query = tx
		.select()
		.from(s.campaignExpenses)
		.where(and(eq(s.campaignExpenses.id, expenseId), eq(s.campaignExpenses.campaignId, campaignId)));
	const [expense] = lock ? await query.for('update') : await query;
	if (!expense) throw notFound('Gasto');
	return expense;
}

async function recordChange(tx: Tx, admin: AdminContext, action: string, campaignId: string, metadata: Record<string, unknown>) {
	await audit(tx, { organizationId: admin.tenant.id, actorType: actorType(admin), actorId: admin.identity.userId, action, targetType: 'campaign', targetId: campaignId, metadata });
	await publishOpsEvent(tx, admin.tenant.id, 'campaign.updated', campaignId);
}

export async function campaignExpenseRoutes(app: FastifyInstance) {
	const { deps } = app;

	app.get('/admin/campaigns/:id/expenses', async (request) => {
		const admin = await requireAdmin(request, 'dashboard.view');
		const { id } = parse(campaignParams, request.params);
		return deps.db.withTenant(admin.tenant.id, async (tx) => {
			const campaign = await loadCampaign(tx, id);
			const expenses = await tx
				.select()
				.from(s.campaignExpenses)
				.where(eq(s.campaignExpenses.campaignId, id))
				.orderBy(desc(s.campaignExpenses.spentOn), desc(s.campaignExpenses.createdAt), desc(s.campaignExpenses.id));
			return { campaign, expenses: expenses.map(expenseView), totalMinor: expenses.reduce((total, expense) => total + expense.amountMinor, 0) };
		});
	});

	app.post('/admin/campaigns/:id/expenses', async (request, reply) => {
		const admin = await requireAdmin(request, 'finance.expenses');
		const { id } = parse(campaignParams, request.params);
		const body: ExpenseInput = parse(expenseInputSchema, request.body);
		const expense = await deps.db.withTenant(admin.tenant.id, async (tx) => {
			await loadCampaign(tx, id);
			const [created] = await tx
				.insert(s.campaignExpenses)
				.values({
					organizationId: admin.tenant.id,
					campaignId: id,
					...body,
					currency: admin.tenant.currency,
					createdBy: admin.identity.userId,
					createdAt: deps.now(),
					updatedBy: admin.identity.userId,
					updatedAt: deps.now()
				})
				.returning();
			await recordChange(tx, admin, 'expense.created', id, auditSummary(created!));
			return created!;
		});
		return reply.status(201).send({ expense: expenseView(expense) });
	});

	app.patch('/admin/campaigns/:id/expenses/:expenseId', async (request) => {
		const admin = await requireAdmin(request, 'finance.expenses');
		const { id, expenseId } = parse(expenseParams, request.params);
		const patch = parse(expensePatchSchema, request.body);
		return deps.db.withTenant(admin.tenant.id, async (tx) => {
			const current = await loadExpense(tx, id, expenseId, true);
			const changed = (Object.keys(patch) as (keyof typeof patch)[]).filter((field) => patch[field] !== current[field]);
			if (changed.length === 0) return { expense: expenseView(current) };
			const [updated] = await tx
				.update(s.campaignExpenses)
				.set({ ...patch, updatedBy: admin.identity.userId, updatedAt: deps.now() })
				.where(eq(s.campaignExpenses.id, expenseId))
				.returning();
			const compared = auditedFields.filter((field) => changed.includes(field));
			await recordChange(tx, admin, 'expense.updated', id, {
				...auditSummary(updated!),
				changed,
				before: Object.fromEntries(compared.map((field) => [field, current[field]])),
				after: Object.fromEntries(compared.map((field) => [field, updated![field]]))
			});
			return { expense: expenseView(updated!) };
		});
	});

	app.delete('/admin/campaigns/:id/expenses/:expenseId', async (request) => {
		const admin = await requireAdmin(request, 'finance.expenses');
		const { id, expenseId } = parse(expenseParams, request.params);
		return deps.db.withTenant(admin.tenant.id, async (tx) => {
			const expense = await loadExpense(tx, id, expenseId, true);
			await tx.delete(s.campaignExpenses).where(eq(s.campaignExpenses.id, expenseId));
			await recordChange(tx, admin, 'expense.deleted', id, auditSummary(expense));
			return { ok: true };
		});
	});
}
