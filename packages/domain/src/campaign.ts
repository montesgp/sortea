/**
 * Campaign lifecycle (FR-CAMP-01) and the compliance gate (AC-12).
 *
 * A campaign can be published so people can read about it, but it can only
 * become `open` (accepting participations) once every required approval is on
 * record. The platform never invents those approvals: a person records each one,
 * with its authority and reference, or the organization owner attests that the
 * paper documentation exists (ADR 0015).
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

/** What an approval rests on: a recorded reference, or the owner's attestation of paper documentation (ADR 0015). */
export const approvalBases = ['document', 'paper'] as const;
export type ApprovalBasis = (typeof approvalBases)[number];

export interface ComplianceApproval {
	readonly kind: ApprovalKind;
	readonly status: 'pending' | 'approved' | 'rejected';
	/** Authority, permit number, PSP case id: whatever proves the approval. */
	readonly reference: string | null;
	readonly decidedAt: Date | null;
	/** `document` when absent. */
	readonly basis?: ApprovalBasis;
}

/**
 * An approval counts once a person decided it and its evidence is on record:
 * the reference, or the owner's paper attestation (ADR 0015).
 */
export function approvalSatisfied(approval: ComplianceApproval | undefined): boolean {
	if (approval?.status !== 'approved' || !approval.decidedAt) return false;
	return approval.basis === 'paper' || Boolean(approval.reference);
}

export interface ComplianceGateResult {
	readonly allowed: boolean;
	readonly missing: ApprovalKind[];
	readonly rejected: ApprovalKind[];
	/** Present only when the local demo mode waived missing approvals (ADR 0013). */
	readonly demo?: true;
}

/**
 * `demo` is the local compliance demo mode for a campaign marked as demo
 * (ADR 0013): it waives missing approvals, which stay reported, but never a
 * rejection. The caller decides it; the approvals themselves never change.
 */
export function evaluateComplianceGate(
	required: readonly ApprovalKind[],
	approvals: readonly ComplianceApproval[],
	options: { demo?: boolean } = {}
): ComplianceGateResult {
	const missing: ApprovalKind[] = [];
	const rejected: ApprovalKind[] = [];
	for (const kind of required) {
		const approval = approvals.find((candidate) => candidate.kind === kind);
		if (approval?.status === 'rejected') rejected.push(kind);
		else if (!approvalSatisfied(approval)) missing.push(kind);
	}
	if (options.demo && missing.length > 0 && rejected.length === 0) return { allowed: true, missing, rejected, demo: true };
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
	/** Prize units neither delivered nor out of alternates (see awards.ts). */
	readonly unresolvedAwardSlots?: number;
	/** Quiniela units a recorded draw left without a winner (ADR 0014 §5). */
	readonly vacantSlots?: number;
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
				| 'manifest_required'
				| 'prizes_vacant'
				| 'awards_pending';
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
	if (to === 'fulfilled' && (context.vacantSlots ?? 0) > 0) return { ok: false, reason: 'prizes_vacant' };
	if (to === 'fulfilled' && (context.unresolvedAwardSlots ?? 1) > 0) return { ok: false, reason: 'awards_pending' };
	return { ok: true };
}

export interface ReopenContext {
	readonly gate: ComplianceGateResult;
	readonly hasLockedRuleVersion: boolean;
	/** The Quiniela draw of the current round is confirmed. */
	readonly roundDrawRecorded: boolean;
	/** The current round's results are published, so they stay attached to it. */
	readonly roundResultsPublished: boolean;
	/** Quiniela units with no winner after that draw. */
	readonly vacantSlots: number;
	readonly now: Date;
	/** The new round's closing date. */
	readonly closesAt: Date;
	/** The new draw or stream date, when one is announced. */
	readonly drawAt: Date | null;
}

export type ReopenResult =
	| { ok: true }
	| { ok: false; reason: 'invalid_transition' | 'draw_pending' | 'no_vacancy' | 'results_pending' | 'invalid_schedule' | 'compliance_gate_closed' | 'missing_rule_version' };

/**
 * Reopening for a new round (ADR 0014 §5): `awarding → open`, a path of its
 * own rather than a plain transition. Only after the round's Quiniela draw
 * left a unit vacant and the round's results were published, with a closing date still ahead (and a draw date after
 * it, if any), and through the same compliance gate as opening. The locked
 * rules stay as they are.
 */
export function canReopen(from: CampaignStatus, context: ReopenContext): ReopenResult {
	if (from !== 'awarding') return { ok: false, reason: 'invalid_transition' };
	if (!context.roundDrawRecorded) return { ok: false, reason: 'draw_pending' };
	if (context.vacantSlots < 1) return { ok: false, reason: 'no_vacancy' };
	if (!context.roundResultsPublished) return { ok: false, reason: 'results_pending' };
	if (context.closesAt <= context.now) return { ok: false, reason: 'invalid_schedule' };
	if (context.drawAt && context.drawAt <= context.closesAt) return { ok: false, reason: 'invalid_schedule' };
	if (!context.gate.allowed) return { ok: false, reason: 'compliance_gate_closed' };
	if (!context.hasLockedRuleVersion) return { ok: false, reason: 'missing_rule_version' };
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

/**
 * What a cart would earn under a locked rule, before knowing the buyer: each
 * line's chances and a total that is exactly what a first purchase allocates.
 * Each chance becomes one numbered entry when the payment is confirmed.
 */
export interface ChanceQuote {
	readonly lines: { variantId: string; chances: number }[];
	readonly total: number;
	readonly maxPerIdentity: number | null;
}

export function quoteChances(rule: EntryAllocationRule, lines: readonly { variantId: string; quantity: number }[]): ChanceQuote {
	return {
		lines: lines.map((line) => ({ variantId: line.variantId, chances: (rule.entriesPerUnit[line.variantId] ?? 0) * line.quantity })),
		total: computeEntryAllocation(rule, lines, 0),
		maxPerIdentity: rule.maxEntriesPerIdentity
	};
}

/** Keeps only variants that grant chances, so the rule's keys are exactly the qualifying variants. */
export function entriesPerUnitFromInput(input: Readonly<Record<string, number>>): Record<string, number> {
	return Object.fromEntries(Object.entries(input).filter(([, chances]) => chances > 0));
}
