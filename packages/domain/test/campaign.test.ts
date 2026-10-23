import { describe, expect, it } from 'vitest';
import {
	acceptsParticipations,
	canReopen,
	canTransition,
	computeEntryAllocation,
	decideRuleChange,
	entriesPerUnitFromInput,
	evaluateComplianceGate,
	quoteChances,
	type CampaignTransitionContext,
	type ComplianceApproval,
	type ReopenContext
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

	it('ADR 0015: an approval the owner attested on paper counts without a reference', () => {
		const paper: ComplianceApproval = { kind: 'psp', status: 'approved', reference: null, decidedAt: new Date('2026-10-22T00:00:00Z'), basis: 'paper' };
		const gate = evaluateComplianceGate(['legal', 'psp'], [approved('legal'), paper]);
		expect(gate).toEqual({ allowed: true, missing: [], rejected: [] });
	});

	it('ADR 0015: a paper attestation still needs the date it was recorded', () => {
		const gate = evaluateComplianceGate(['legal'], [{ kind: 'legal', status: 'approved', reference: null, decidedAt: null, basis: 'paper' }]);
		expect(gate).toEqual({ allowed: false, missing: ['legal'], rejected: [] });
	});

	it('ADR 0015: the paper basis does not turn a pending or rejected approval into an approved one', () => {
		const decidedAt = new Date('2026-10-22T00:00:00Z');
		const gate = evaluateComplianceGate(
			['legal', 'psp'],
			[
				{ kind: 'legal', status: 'pending', reference: null, decidedAt, basis: 'paper' },
				{ kind: 'psp', status: 'rejected', reference: null, decidedAt, basis: 'paper' }
			]
		);
		expect(gate).toEqual({ allowed: false, missing: ['legal'], rejected: ['psp'] });
	});

	it('a document-basis approval still needs its reference', () => {
		const gate = evaluateComplianceGate(['legal'], [{ kind: 'legal', status: 'approved', reference: null, decidedAt: new Date('2026-10-22T00:00:00Z'), basis: 'document' }]);
		expect(gate).toEqual({ allowed: false, missing: ['legal'], rejected: [] });
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

	it('does not finish while a quiniela unit is vacant (ADR 0014 §5)', () => {
		expect(canTransition('awarding', 'fulfilled', { ...baseContext, unresolvedAwardSlots: 0, vacantSlots: 1 })).toEqual({ ok: false, reason: 'prizes_vacant' });
		expect(canTransition('awarding', 'fulfilled', { ...baseContext, unresolvedAwardSlots: 2, vacantSlots: 2 })).toEqual({ ok: false, reason: 'prizes_vacant' });
		expect(canTransition('awarding', 'fulfilled', { ...baseContext, unresolvedAwardSlots: 0, vacantSlots: 0 })).toEqual({ ok: true });
	});

	it('never goes back to open through a plain transition: reopening is its own action', () => {
		expect(canTransition('awarding', 'open', { ...baseContext, now: new Date('2026-10-01T00:00:00Z') })).toEqual({ ok: false, reason: 'invalid_transition' });
	});
});

describe('reopening for a new round (ADR 0014 §5)', () => {
	const reopen: ReopenContext = {
		gate: baseContext.gate,
		hasLockedRuleVersion: true,
		roundDrawRecorded: true,
		roundResultsPublished: true,
		vacantSlots: 1,
		now: new Date('2026-12-01T12:00:00Z'),
		closesAt: new Date('2026-12-20T23:00:00Z'),
		drawAt: null
	};

	it('reopens an awarding campaign whose round draw left a quiniela unit vacant', () => {
		expect(canReopen('awarding', reopen)).toEqual({ ok: true });
		expect(canReopen('awarding', { ...reopen, vacantSlots: 3, drawAt: new Date('2026-12-21T00:00:00Z') })).toEqual({ ok: true });
	});

	it('only from awarding', () => {
		for (const status of ['draft', 'review', 'published', 'open', 'closed', 'fulfilled', 'archived'] as const) {
			expect(canReopen(status, reopen), status).toEqual({ ok: false, reason: 'invalid_transition' });
		}
	});

	it('only after the round draw is recorded, and only with a vacant unit', () => {
		expect(canReopen('awarding', { ...reopen, roundDrawRecorded: false })).toEqual({ ok: false, reason: 'draw_pending' });
		expect(canReopen('awarding', { ...reopen, vacantSlots: 0 })).toEqual({ ok: false, reason: 'no_vacancy' });
	});

	it('only once the round results are published, so they stay attached to their round', () => {
		expect(canReopen('awarding', { ...reopen, roundResultsPublished: false })).toEqual({ ok: false, reason: 'results_pending' });
	});

	it('needs a closing date later than now, and a draw date after it when one is given', () => {
		expect(canReopen('awarding', { ...reopen, closesAt: reopen.now })).toEqual({ ok: false, reason: 'invalid_schedule' });
		expect(canReopen('awarding', { ...reopen, closesAt: new Date('2026-11-30T00:00:00Z') })).toEqual({ ok: false, reason: 'invalid_schedule' });
		expect(canReopen('awarding', { ...reopen, drawAt: reopen.closesAt })).toEqual({ ok: false, reason: 'invalid_schedule' });
	});

	it('passes the compliance gate exactly like opening, demo waiver included', () => {
		const pending: ComplianceApproval = { kind: 'legal', status: 'pending', reference: null, decidedAt: null };
		expect(canReopen('awarding', { ...reopen, gate: evaluateComplianceGate(['legal', 'psp'], [approved('psp'), pending]) })).toEqual({ ok: false, reason: 'compliance_gate_closed' });
		expect(canReopen('awarding', { ...reopen, gate: evaluateComplianceGate(['legal', 'psp'], [approved('psp'), pending], { demo: true }) })).toEqual({ ok: true });
		expect(canReopen('awarding', { ...reopen, hasLockedRuleVersion: false })).toEqual({ ok: false, reason: 'missing_rule_version' });
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
