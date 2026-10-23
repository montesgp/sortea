import { and, asc, desc, eq, gt, inArray, schema as s, sql, type Executor } from '@sortea/db';
import { acceptsParticipations, evaluateComplianceGate, remainingCoupons, type ComplianceGateResult } from '@sortea/domain';

type CampaignRow = typeof s.campaigns.$inferSelect;

/** Minutes a pending order stays payable; campaigns close only after the last one could have settled. */
export const ORDER_TTL_MINUTES = 60;

/**
 * The campaign's compliance gate. `complianceDemo` is the API's COMPLIANCE_DEMO
 * setting (local only); it waives pending approvals of campaigns marked as demo
 * and nothing else (ADR 0013).
 */
export async function campaignGate(
	executor: Executor,
	campaign: Pick<CampaignRow, 'id' | 'requiredApprovals' | 'isDemo'>,
	complianceDemo: boolean
): Promise<ComplianceGateResult> {
	const approvals = await executor.select().from(s.campaignApprovals).where(eq(s.campaignApprovals.campaignId, campaign.id));
	return evaluateComplianceGate(
		campaign.requiredApprovals,
		approvals.map((approval) => ({
			kind: approval.kind,
			status: approval.status,
			reference: approval.reference,
			decidedAt: approval.decidedAt,
			basis: approval.basis
		})),
		{ demo: complianceDemo && campaign.isDemo }
	);
}

export async function lockedRuleVersion(executor: Executor, campaignId: string) {
	const [rule] = await executor
		.select()
		.from(s.campaignRuleVersions)
		.where(and(eq(s.campaignRuleVersions.campaignId, campaignId), eq(s.campaignRuleVersions.status, 'locked')))
		.orderBy(desc(s.campaignRuleVersions.version))
		.limit(1);
	return rule ?? null;
}

/**
 * The campaign a purchase made now counts for, with its locked rule: the one
 * named by the buyer while it accepts participations, or else the open
 * campaign closing first (a stale slug from the cart falls back too, so the
 * shop, the quote and the order name the same campaign). Null when no
 * campaign accepts participations, so nothing promises chances (FR-CAMP-05).
 */
export async function participationCampaign(executor: Executor, now: Date, complianceDemo: boolean, slug?: string) {
	if (slug) {
		const named = await firstAccepting(executor, now, complianceDemo, slug);
		if (named) return named;
	}
	return firstAccepting(executor, now, complianceDemo);
}

async function firstAccepting(executor: Executor, now: Date, complianceDemo: boolean, slug?: string) {
	const candidates = await executor
		.select()
		.from(s.campaigns)
		.where(and(eq(s.campaigns.status, 'open'), slug ? eq(s.campaigns.slug, slug) : undefined))
		.orderBy(asc(s.campaigns.closesAt), asc(s.campaigns.id));
	for (const campaign of candidates) {
		if (!acceptsParticipations(campaign.status, await campaignGate(executor, campaign, complianceDemo), campaign, now)) continue;
		const rule = await lockedRuleVersion(executor, campaign.id);
		if (rule) return { campaign, rule };
	}
	return null;
}

export async function latestRuleVersion(executor: Executor, campaignId: string) {
	const [rule] = await executor
		.select()
		.from(s.campaignRuleVersions)
		.where(eq(s.campaignRuleVersions.campaignId, campaignId))
		.orderBy(desc(s.campaignRuleVersions.version))
		.limit(1);
	return rule ?? null;
}

/**
 * Chances held by the campaign's orders that can still be paid (ADR 0014 §1): pending ones and,
 * since a rejected payment may be retried and approved within the TTL, failed ones too.
 */
export async function reservedCoupons(executor: Executor, campaignId: string, now: Date): Promise<number> {
	const [row] = await executor
		.select({ value: sql<string>`coalesce(sum(${s.orders.reservedEntries}), 0)` })
		.from(s.orders)
		.where(and(eq(s.orders.campaignId, campaignId), inArray(s.orders.status, ['pending_payment', 'payment_failed']), gt(s.orders.expiresAt, now)));
	return Number(row?.value ?? 0);
}

/**
 * Coupons a new order can still take: the pool minus the numbers allocated and the
 * reservations. Exact only under the campaign row lock; elsewhere it is a snapshot.
 */
export async function couponsRemaining(executor: Executor, campaign: Pick<CampaignRow, 'id' | 'entryDigits' | 'nextEntryNumber'>, now: Date): Promise<number> {
	return remainingCoupons({ entryDigits: campaign.entryDigits, nextEntryNumber: campaign.nextEntryNumber, reserved: await reservedCoupons(executor, campaign.id, now) });
}
