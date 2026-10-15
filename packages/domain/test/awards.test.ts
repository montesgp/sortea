import { describe, expect, it } from 'vitest';
import { canDecide, canMoveFulfillment, canRecordSlot, checkSlotResult, slotResolved, slotState, type SlotAward } from '../src';

const award = (id: string, role: SlotAward['role'], rank: number, status: SlotAward['status'] = 'pending_verification', fulfillmentStatus: SlotAward['fulfillmentStatus'] = null): SlotAward => ({
	id,
	role,
	rank,
	status,
	fulfillmentStatus
});

describe('award slots', () => {
	it('offers the prize to the winner first, then to alternates in order', () => {
		const slot = [award('a2', 'alternate', 2), award('w', 'winner', 1), award('a1', 'alternate', 1)];
		expect(slotState(slot)).toMatchObject({ state: 'verifying', award: { id: 'w' } });

		const declined = slot.map((item) => (item.id === 'w' ? { ...item, status: 'declined' as const } : item));
		expect(slotState(declined)).toMatchObject({ state: 'verifying', award: { id: 'a1' } });

		const exhausted = slot.map((item) => ({ ...item, status: item.id === 'a2' ? ('void' as const) : ('declined' as const) }));
		expect(slotState(exhausted)).toEqual({ state: 'exhausted' });
		expect(slotResolved(exhausted)).toBe(true);
	});

	it('is resolved only when delivered or exhausted', () => {
		expect(slotResolved([])).toBe(false);
		expect(slotResolved([award('w', 'winner', 1, 'accepted', 'scheduled')])).toBe(false);
		expect(slotState([award('w', 'winner', 1, 'accepted', 'delivered')]).state).toBe('delivered');
		expect(slotResolved([award('w', 'winner', 1, 'accepted', 'delivered')])).toBe(true);
	});

	it('lets only the current holder be decided, once', () => {
		const slot = [award('w', 'winner', 1), award('a1', 'alternate', 1)];
		expect(canDecide(slot, 'a1')).toEqual({ ok: false, reason: 'not_active' });
		expect(canDecide(slot, 'w')).toEqual({ ok: true });
		const accepted = [award('w', 'winner', 1, 'accepted'), award('a1', 'alternate', 1)];
		expect(canDecide(accepted, 'w')).toEqual({ ok: false, reason: 'already_decided' });
		expect(canDecide(accepted, 'a1')).toEqual({ ok: false, reason: 'not_active' });
	});

	it('allows fixing a typo only before any decision and before results are public', () => {
		expect(canRecordSlot([], false)).toBe(true);
		expect(canRecordSlot([award('w', 'winner', 1)], false)).toBe(true);
		expect(canRecordSlot([award('w', 'winner', 1)], true)).toBe(false);
		expect(canRecordSlot([award('w', 'winner', 1, 'declined'), award('a1', 'alternate', 1)], false)).toBe(false);
	});
});

describe('slot results against the manifest', () => {
	const manifest = new Map<number, 'eligible' | 'void'>([
		[1, 'eligible'],
		[2, 'eligible'],
		[3, 'void'],
		[4, 'eligible']
	]);
	const lookup = (entryNumber: number) => manifest.get(entryNumber) ?? null;

	it('accepts eligible, distinct entries within the alternates allowed', () => {
		expect(checkSlotResult({ winner: 1, alternates: [2], alternatesAllowed: 1 }, lookup, new Set())).toEqual({ ok: true });
	});

	it('rejects what the published list does not support', () => {
		expect(checkSlotResult({ winner: 99, alternates: [], alternatesAllowed: 1 }, lookup, new Set())).toEqual({ ok: false, reason: 'not_in_manifest', entryNumber: 99 });
		expect(checkSlotResult({ winner: 3, alternates: [], alternatesAllowed: 1 }, lookup, new Set())).toEqual({ ok: false, reason: 'not_eligible', entryNumber: 3 });
		expect(checkSlotResult({ winner: 1, alternates: [1], alternatesAllowed: 1 }, lookup, new Set())).toEqual({ ok: false, reason: 'duplicate_entry', entryNumber: 1 });
		expect(checkSlotResult({ winner: 1, alternates: [2, 4], alternatesAllowed: 1 }, lookup, new Set()).ok).toBe(false);
		expect(checkSlotResult({ winner: 4, alternates: [], alternatesAllowed: 0 }, lookup, new Set([4]))).toEqual({ ok: false, reason: 'already_awarded', entryNumber: 4 });
	});
});

describe('fulfillment', () => {
	it('moves forward, allows retrying a failed delivery and freezes once delivered', () => {
		expect(canMoveFulfillment(null, 'scheduled')).toBe(true);
		expect(canMoveFulfillment(null, 'failed')).toBe(false);
		expect(canMoveFulfillment('scheduled', 'failed')).toBe(true);
		expect(canMoveFulfillment('failed', 'scheduled')).toBe(true);
		expect(canMoveFulfillment('scheduled', 'delivered')).toBe(true);
		expect(canMoveFulfillment('delivered', 'scheduled')).toBe(false);
		expect(canMoveFulfillment('pending', 'pending')).toBe(false);
	});
});
