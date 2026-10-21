import { describe, expect, it } from 'vitest';
import {
	acceptsParticipations,
	canTransition,
	computeEntryAllocation,
	decideRuleChange,
	entriesPerUnitFromInput,
	evaluateComplianceGate,
	quoteChances,
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

	it('the local demo mode waives missing approvals and still reports them', () => {
		const pending: ComplianceApproval = { kind: 'psp', status: 'pending', reference: null, decidedAt: null };
		const gate = evaluateComplianceGate(['legal', 'psp'], [pending], { demo: true });
		expect(gate).toEqual({ allowed: true, missing: ['legal', 'psp'], rejected: [], demo: true });
	});

	it('the local demo mode never waives a rejection', () => {
		const gate = evaluateComplianceGate(['legal', 'psp'], [{ ...approved('psp'), status: 'rejected' }], { demo: true });
		expect(gate).toEqual({ allowed: false, missing: ['legal'], rejected: ['psp'] });
	});

	it('an approved gate is not marked as demo', () => {
		const gate = evaluateComplianceGate(['legal'], [approved('legal')], { demo: true });
		expect(gate).toEqual({ allowed: true, missing: [], rejected: [] });
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

describe('chances per product (S5)', () => {
	const rule = { mode: 'per_unit' as const, entriesPerUnit: { manual: 3, cap: 1 }, maxEntriesPerIdentity: null };

	it('multiplies the chances of each line by its quantity: two manuals give double', () => {
		const one = quoteChances(rule, [{ variantId: 'manual', quantity: 1 }]);
		const two = quoteChances(rule, [{ variantId: 'manual', quantity: 2 }]);
		expect(one).toEqual({ lines: [{ variantId: 'manual', chances: 3 }], total: 3, maxPerIdentity: null });
		expect(two.total).toBe(2 * one.total);
	});

	it('gives no chances to variants the rules do not name and matches the allocation', () => {
		const lines = [
			{ variantId: 'manual', quantity: 2 },
			{ variantId: 'cap', quantity: 1 },
			{ variantId: 'sticker', quantity: 4 }
		];
		const quote = quoteChances(rule, lines);
		expect(quote.lines).toEqual([
			{ variantId: 'manual', chances: 6 },
			{ variantId: 'cap', chances: 1 },
			{ variantId: 'sticker', chances: 0 }
		]);
		expect(quote.total).toBe(computeEntryAllocation(rule, lines, 0));
	});

	it('never promises more than the cap per person', () => {
		const capped = quoteChances({ ...rule, maxEntriesPerIdentity: 4 }, [{ variantId: 'manual', quantity: 2 }]);
		expect(capped).toEqual({ lines: [{ variantId: 'manual', chances: 6 }], total: 4, maxPerIdentity: 4 });
	});

	it('quotes exactly what a first purchase allocates; a returning buyer near the cap gets fewer', () => {
		const capped = { ...rule, maxEntriesPerIdentity: 10 };
		const lines = [{ variantId: 'manual', quantity: 2 }];
		const quote = quoteChances(capped, lines);
		expect(quote.total).toBe(computeEntryAllocation(capped, lines, 0));
		expect(quote.total).toBe(6);
		expect(computeEntryAllocation(capped, lines, 7)).toBe(3);
		expect(computeEntryAllocation(capped, lines, 10)).toBe(0);
	});

	it('stores only the variants that grant chances: zero means it does not participate', () => {
		expect(entriesPerUnitFromInput({ manual: 2, sticker: 0, cap: 1 })).toEqual({ manual: 2, cap: 1 });
		expect(entriesPerUnitFromInput({ sticker: 0 })).toEqual({});
	});
});
