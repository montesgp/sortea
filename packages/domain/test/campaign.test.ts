import { describe, expect, it } from 'vitest';
import {
	acceptsParticipations,
	canTransition,
	computeEntryAllocation,
	decideRuleChange,
	evaluateComplianceGate,
	type CampaignTransitionContext,
	type ComplianceApproval
} from '../src';

const approved = (kind: 'legal' | 'psp'): ComplianceApproval => ({
	kind,
	status: 'approved',
	reference: `REF-${kind}`,
	decidedAt: new Date('2026-10-01T00:00:00Z')
});

const baseContext: CampaignTransitionContext = {
	gate: evaluateComplianceGate(['legal', 'psp'], [approved('legal'), approved('psp')]),
	hasLockedRuleVersion: true,
	prizeCount: 16,
	opensAt: new Date('2026-10-10T00:00:00Z'),
	closesAt: new Date('2026-11-08T22:00:00Z'),
	now: new Date('2026-10-14T00:00:00Z'),
	hasPublishedManifest: false
};

describe('compliance gate', () => {
	it('is closed while any required approval is missing', () => {
		const gate = evaluateComplianceGate(['legal', 'psp'], [approved('legal')]);
		expect(gate).toEqual({ allowed: false, missing: ['psp'], rejected: [] });
	});

	it('does not accept an "approved" record without evidence', () => {
		const gate = evaluateComplianceGate(['legal'], [{ kind: 'legal', status: 'approved', reference: null, decidedAt: null }]);
		expect(gate.allowed).toBe(false);
	});

	it('reports rejections separately', () => {
		const gate = evaluateComplianceGate(['psp'], [{ ...approved('psp'), status: 'rejected' }]);
		expect(gate.rejected).toEqual(['psp']);
	});
});

describe('campaign transitions', () => {
	it('AC-12: cannot open without the required approvals', () => {
		const gate = evaluateComplianceGate(['legal', 'psp'], [approved('legal')]);
		expect(canTransition('published', 'open', { ...baseContext, gate })).toEqual({
			ok: false,
			reason: 'compliance_gate_closed'
		});
	});

	it('opens when approvals, rules and prizes are in place', () => {
		expect(canTransition('published', 'open', baseContext)).toEqual({ ok: true });
	});

	it('cannot skip lifecycle steps', () => {
		expect(canTransition('draft', 'open', baseContext)).toEqual({ ok: false, reason: 'invalid_transition' });
		expect(canTransition('open', 'draft', baseContext)).toEqual({ ok: false, reason: 'invalid_transition' });
	});

	it('requires a published manifest before awarding', () => {
		expect(canTransition('closed', 'awarding', baseContext)).toEqual({ ok: false, reason: 'manifest_required' });
		expect(canTransition('closed', 'awarding', { ...baseContext, hasPublishedManifest: true })).toEqual({ ok: true });
	});

	it('finishes only when every prize unit was delivered or ran out of alternates (AC-06)', () => {
		expect(canTransition('awarding', 'fulfilled', baseContext)).toEqual({ ok: false, reason: 'awards_pending' });
		expect(canTransition('awarding', 'fulfilled', { ...baseContext, unresolvedAwardSlots: 3 })).toEqual({ ok: false, reason: 'awards_pending' });
		expect(canTransition('awarding', 'fulfilled', { ...baseContext, unresolvedAwardSlots: 0 })).toEqual({ ok: true });
	});
});

describe('rule changes (AC-08)', () => {
	it('allows editing in place before opening', () => {
		expect(decideRuleChange('published', { approvedBy: null, announcement: null })).toEqual({
			allowed: true,
			mode: 'edit_draft'
		});
	});

	it('refuses silent edits after opening', () => {
		expect(decideRuleChange('open', { approvedBy: null, announcement: null }).allowed).toBe(false);
		expect(decideRuleChange('open', { approvedBy: 'user-1', announcement: '  ' }).allowed).toBe(false);
	});

	it('requires a new approved and announced version after opening', () => {
		expect(decideRuleChange('open', { approvedBy: 'user-1', announcement: 'Cambio de fecha' })).toEqual({
			allowed: true,
			mode: 'new_version'
		});
	});
});

describe('participations', () => {
	const window = { opensAt: baseContext.opensAt, closesAt: baseContext.closesAt };

	it('are only accepted while open, inside the window and with the gate passed', () => {
		expect(acceptsParticipations('open', baseContext.gate, window, baseContext.now)).toBe(true);
		expect(acceptsParticipations('published', baseContext.gate, window, baseContext.now)).toBe(false);
		expect(acceptsParticipations('open', baseContext.gate, window, baseContext.closesAt)).toBe(false);
		const closedGate = evaluateComplianceGate(['legal'], []);
		expect(acceptsParticipations('open', closedGate, window, baseContext.now)).toBe(false);
	});

	it('allocates entries only for variants the rules name, respecting the identity cap', () => {
		const rule = { mode: 'per_unit' as const, entriesPerUnit: { manual: 1 }, maxEntriesPerIdentity: 3 };
		const lines = [
			{ variantId: 'manual', quantity: 2 },
			{ variantId: 'sticker', quantity: 5 }
		];
		expect(computeEntryAllocation(rule, lines, 0)).toBe(2);
		expect(computeEntryAllocation(rule, lines, 2)).toBe(1);
		expect(computeEntryAllocation(rule, lines, 3)).toBe(0);
	});
});
