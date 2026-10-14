/**
 * Campaign lifecycle (FR-CAMP-01) and the compliance gate (AC-12).
 *
 * A campaign can be published so people can read about it, but it can only
 * become `open` (accepting participations) once every required approval is on
 * record. The platform never invents those approvals.
 */
export const campaignStatuses = [
	'draft',
	'review',
	'published',
	'open',
	'closed',
	'awarding',
	'fulfilled',
	'archived'
] as const;

export type CampaignStatus = (typeof campaignStatuses)[number];

const transitions: Record<CampaignStatus, readonly CampaignStatus[]> = {
	draft: ['review', 'archived'],
	review: ['draft', 'published', 'archived'],
	published: ['open', 'review', 'archived'],
	open: ['closed'],
	closed: ['awarding'],
	awarding: ['fulfilled'],
	fulfilled: ['archived'],
	archived: []
};

export const approvalKinds = ['legal', 'psp'] as const;
export type ApprovalKind = (typeof approvalKinds)[number];

export interface ComplianceApproval {
	readonly kind: ApprovalKind;
	readonly status: 'pending' | 'approved' | 'rejected';
	/** Authority, permit number, PSP case id: whatever proves the approval. */
	readonly reference: string | null;
	readonly decidedAt: Date | null;
}

export interface ComplianceGateResult {
	readonly allowed: boolean;
	readonly missing: ApprovalKind[];
	readonly rejected: ApprovalKind[];
}

export function evaluateComplianceGate(
	required: readonly ApprovalKind[],
	approvals: readonly ComplianceApproval[]
): ComplianceGateResult {
	const missing: ApprovalKind[] = [];
	const rejected: ApprovalKind[] = [];
	for (const kind of required) {
		const approval = approvals.find((candidate) => candidate.kind === kind);
		if (approval?.status === 'rejected') rejected.push(kind);
		else if (approval?.status !== 'approved' || !approval.reference || !approval.decidedAt) missing.push(kind);
	}
	return { allowed: missing.length === 0 && rejected.length === 0, missing, rejected };
}

export interface CampaignTransitionContext {
	readonly gate: ComplianceGateResult;
	readonly hasLockedRuleVersion: boolean;
	readonly prizeCount: number;
	readonly opensAt: Date;
	readonly closesAt: Date;
	readonly now: Date;
	readonly hasPublishedManifest: boolean;
}

export type TransitionResult =
	| { ok: true }
	| {
			ok: false;
			reason:
				| 'invalid_transition'
				| 'compliance_gate_closed'
				| 'missing_rule_version'
				| 'missing_prizes'
				| 'invalid_schedule'
				| 'manifest_required';
	  };

export function canTransition(
	from: CampaignStatus,
	to: CampaignStatus,
	context: CampaignTransitionContext
): TransitionResult {
	if (!transitions[from].includes(to)) return { ok: false, reason: 'invalid_transition' };

	if (to === 'published' || to === 'open') {
		if (context.prizeCount < 1) return { ok: false, reason: 'missing_prizes' };
		if (context.closesAt <= context.opensAt) return { ok: false, reason: 'invalid_schedule' };
	}
	if (to === 'open') {
		if (!context.gate.allowed) return { ok: false, reason: 'compliance_gate_closed' };
		if (!context.hasLockedRuleVersion) return { ok: false, reason: 'missing_rule_version' };
		if (context.now >= context.closesAt) return { ok: false, reason: 'invalid_schedule' };
	}
	if (to === 'awarding' && !context.hasPublishedManifest) return { ok: false, reason: 'manifest_required' };
	return { ok: true };
}

export function allowedTransitions(from: CampaignStatus): readonly CampaignStatus[] {
	return transitions[from];
}

/** Essential rules are frozen once the campaign opens (FR-CAMP-06, AC-08). */
export function rulesAreLocked(status: CampaignStatus): boolean {
	return !['draft', 'review', 'published'].includes(status);
}

export type RuleChangeDecision =
	| { allowed: true; mode: 'edit_draft' | 'new_version' }
	| { allowed: false; reason: 'rules_locked_requires_material_change_process' | 'campaign_finished' };

/**
 * Before opening, the working rule version can be edited in place. After
 * opening, the only path is a new version with explicit approval and a public
 * announcement; published versions are never rewritten.
 */
export function decideRuleChange(
	status: CampaignStatus,
	change: { approvedBy: string | null; announcement: string | null }
): RuleChangeDecision {
	if (!rulesAreLocked(status)) return { allowed: true, mode: 'edit_draft' };
	if (status !== 'open') return { allowed: false, reason: 'campaign_finished' };
	if (!change.approvedBy || !change.announcement?.trim()) {
		return { allowed: false, reason: 'rules_locked_requires_material_change_process' };
	}
	return { allowed: true, mode: 'new_version' };
}

/** Whether a purchase made now can produce participations for this campaign. */
export function acceptsParticipations(
	status: CampaignStatus,
	gate: ComplianceGateResult,
	window: { opensAt: Date; closesAt: Date },
	now: Date
): boolean {
	return status === 'open' && gate.allowed && now >= window.opensAt && now < window.closesAt;
}

/**
 * Entry allocation rule stored inside a locked rule version. Only applied when
 * the authorized modality allows it (FR-CAMP-05); buying more never implies
 * more chances unless the approved rules say so.
 */
export interface EntryAllocationRule {
	readonly mode: 'per_unit';
	/** Entries granted per purchased unit, keyed by variant id. */
	readonly entriesPerUnit: Readonly<Record<string, number>>;
	/** Optional cap per identity for the whole campaign. */
	readonly maxEntriesPerIdentity: number | null;
}

export function computeEntryAllocation(
	rule: EntryAllocationRule,
	lines: readonly { variantId: string; quantity: number }[],
	alreadyAllocatedToIdentity: number
): number {
	const requested = lines.reduce(
		(sum, line) => sum + (rule.entriesPerUnit[line.variantId] ?? 0) * line.quantity,
		0
	);
	if (rule.maxEntriesPerIdentity === null) return requested;
	return Math.max(0, Math.min(requested, rule.maxEntriesPerIdentity - alreadyAllocatedToIdentity));
}
