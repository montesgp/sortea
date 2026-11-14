import type { AwardOrder } from '@sortea/domain';
import { sha256Hex } from '@sortea/domain/server';
import type { Tx } from './client';
import * as s from './schema';

type PrizeRow = typeof s.prizes.$inferInsert;
type ApprovalKind = (typeof s.campaignApprovals.$inferInsert)['kind'];

/** A prize as a new campaign lists it; its position follows the list. */
export type NewCampaignPrize = Omit<PrizeRow, 'id' | 'organizationId' | 'campaignId' | 'position'>;

export interface NewCampaign {
	slug: string;
	title: string;
	subtitle: string | null;
	summary: string;
	/** `draft` from the admin; a client pack's demo campaign is created `published`. Never `open`: opening goes through the gate. */
	status: 'draft' | 'published';
	timezone: string;
	/** Null while a draft waits for its dates; a published campaign needs both (`campaigns_schedule_check`). */
	opensAt: Date | null;
	closesAt: Date | null;
	drawAt: Date | null;
	isDemo: boolean;
	seo: { title?: string; description?: string };
	/** Saved as version 1 of the rules, in draft. */
	rulesMarkdown: string;
	eligibility: { minAge: number; residency: string; excluded: string[] };
	/** Chances per unit by variant id; only values above 0 are kept. */
	entriesPerUnit: Record<string, number>;
	/** Which prize the first Quiniela match goes to (ADR 0014 §4); `first_to_last` when absent. */
	awardOrder?: AwardOrder;
	/** Each one is created pending. Defaults to legal and payment provider. */
	requiredApprovals?: ApprovalKind[];
	prizes?: NewCampaignPrize[];
	faqs?: { question: string; answer: string }[];
}

/**
 * Creates a campaign the one way both the admin (POST /admin/campaigns) and a
 * client pack do: the campaign row, its required approvals pending, version 1
 * of the rules in draft with its chances, and its prizes and FAQs. Approvals
 * are recorded later by a person in the admin (ADR 0015); nothing here grants
 * one. The caller checks the slug and runs inside the tenant's transaction.
 */
export async function createCampaign(tx: Tx, organizationId: string, campaign: NewCampaign): Promise<string> {
	const requiredApprovals = campaign.requiredApprovals ?? ['legal', 'psp'];
	const [row] = await tx
		.insert(s.campaigns)
		.values({
			organizationId,
			slug: campaign.slug,
			title: campaign.title,
			subtitle: campaign.subtitle,
			summary: campaign.summary,
			status: campaign.status,
			timezone: campaign.timezone,
			opensAt: campaign.opensAt,
			closesAt: campaign.closesAt,
			drawAt: campaign.drawAt,
			requiredApprovals,
			isDemo: campaign.isDemo,
			seo: campaign.seo,
			awardOrder: campaign.awardOrder ?? 'first_to_last'
		})
		.returning({ id: s.campaigns.id });
	const campaignId = row!.id;
	if (requiredApprovals.length > 0) {
		await tx.insert(s.campaignApprovals).values(requiredApprovals.map((kind) => ({ organizationId, campaignId, kind, status: 'pending' as const })));
	}
	const entriesPerUnit = Object.fromEntries(Object.entries(campaign.entriesPerUnit).filter(([, perUnit]) => perUnit > 0));
	await tx.insert(s.campaignRuleVersions).values({
		organizationId,
		campaignId,
		version: 1,
		status: 'draft',
		bodyMarkdown: campaign.rulesMarkdown,
		eligibility: campaign.eligibility,
		entryRule: { mode: 'per_unit', entriesPerUnit, maxEntriesPerIdentity: null },
		contentHash: sha256Hex(campaign.rulesMarkdown)
	});
	if (campaign.prizes?.length) {
		await tx.insert(s.prizes).values(campaign.prizes.map((prize, index) => ({ ...prize, organizationId, campaignId, position: index + 1 })));
	}
	if (campaign.faqs?.length) {
		await tx.insert(s.campaignFaqs).values(campaign.faqs.map((faq, position) => ({ organizationId, campaignId, position, ...faq })));
	}
	return campaignId;
}
