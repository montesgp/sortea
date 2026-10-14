import { and, desc, eq, schema as s, type Executor } from '@sortea/db';
import { evaluateComplianceGate, type ComplianceGateResult } from '@sortea/domain';

type CampaignRow = typeof s.campaigns.$inferSelect;

/** Minutes a pending order stays payable; campaigns close only after the last one could have settled. */
export const ORDER_TTL_MINUTES = 60;

export async function campaignGate(executor: Executor, campaign: Pick<CampaignRow, 'id' | 'requiredApprovals'>): Promise<ComplianceGateResult> {
	const approvals = await executor.select().from(s.campaignApprovals).where(eq(s.campaignApprovals.campaignId, campaign.id));
	return evaluateComplianceGate(
		campaign.requiredApprovals,
		approvals.map((approval) => ({
			kind: approval.kind,
			status: approval.status,
			reference: approval.reference,
			decidedAt: approval.decidedAt
		}))
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

export async function latestRuleVersion(executor: Executor, campaignId: string) {
	const [rule] = await executor
		.select()
		.from(s.campaignRuleVersions)
		.where(eq(s.campaignRuleVersions.campaignId, campaignId))
		.orderBy(desc(s.campaignRuleVersions.version))
		.limit(1);
	return rule ?? null;
}
