import { padEntryNumber } from './coupons';

/**
 * Vacant prizes drawn in the application (ADR 0024). When the round's Quiniela
 * draw leaves `quiniela` units without a winner, the API draws them among the
 * eligible coupons that hold no award, with a cryptographic random index, and
 * stores the result before any screen shows it.
 */

/** A vacant unit to draw, in prize order (ADR 0014 §4), with the alternates its prize allows. */
export interface AppDrawSlot {
	readonly prizeId: string;
	readonly slot: number;
	readonly alternatesCount: number;
}

export interface AppDrawPick {
	readonly prizeId: string;
	readonly slot: number;
	readonly role: 'winner' | 'alternate';
	/** 1 for the winner; the alternate's place, from 1. */
	readonly rank: number;
	readonly entryNumber: number;
}

/**
 * Draws without replacement from the candidates, sorted ascending: first a
 * winner for every slot in the given order, then each slot that got a winner
 * its alternates, slot by slot. Winners go first so that, with few coupons
 * left, a prize never stays vacant while an earlier one gets alternates.
 * `randomIndex(size)` returns an integer in [0, size), uniformly
 * (`crypto.randomInt` in the API). Stops when the coupons run out.
 */
export function drawVacantSlots(input: {
	readonly slots: readonly AppDrawSlot[];
	readonly candidates: readonly number[];
	readonly randomIndex: (size: number) => number;
}): AppDrawPick[] {
	const pool = [...new Set(input.candidates)].sort((a, b) => a - b);
	const take = (): number | null => {
		if (pool.length === 0) return null;
		const index = input.randomIndex(pool.length);
		if (!Number.isInteger(index) || index < 0 || index >= pool.length) throw new RangeError(`random index ${index} outside [0, ${pool.length})`);
		return pool.splice(index, 1)[0]!;
	};

	const picks: AppDrawPick[] = [];
	const won: AppDrawSlot[] = [];
	for (const slot of input.slots) {
		const entryNumber = take();
		if (entryNumber === null) return picks;
		picks.push({ prizeId: slot.prizeId, slot: slot.slot, role: 'winner', rank: 1, entryNumber });
		won.push(slot);
	}
	for (const slot of won) {
		for (let rank = 1; rank <= slot.alternatesCount; rank++) {
			const entryNumber = take();
			if (entryNumber === null) return picks;
			picks.push({ prizeId: slot.prizeId, slot: slot.slot, role: 'alternate', rank, entryNumber });
		}
	}
	return picks;
}

/**
 * The canonical text of a candidate list, whose SHA-256 is published: the
 * coupons ascending, zero-padded to the campaign's digits, one per line, `\n`
 * line endings and no final newline. `printf '0003\n0007' | sha256sum` checks it.
 */
export function appDrawCandidateText(entryNumbers: readonly number[], entryDigits: number): string {
	return [...entryNumbers]
		.sort((a, b) => a - b)
		.map((entryNumber) => padEntryNumber(entryNumber, entryDigits))
		.join('\n');
}

/**
 * How the draw screen names a coupon's holder: the first two letters of the
 * first name, "***", and the initial of the last name ("Ju*** P."). Only
 * letters count, so nothing else typed in the name leaks; never the full
 * name, and never document, email or phone.
 */
export function maskHolderName(firstName: string, lastName: string): string {
	const letters = (value: string) => Array.from(value.normalize('NFC')).filter((character) => /\p{L}/u.test(character));
	const [firstWord = ''] = firstName.trim().split(/\s+/);
	const head = letters(firstWord)
		.slice(0, 2)
		.map((character, index) => (index === 0 ? character.toLocaleUpperCase('es-AR') : character.toLocaleLowerCase('es-AR')))
		.join('');
	const initial = letters(lastName)[0];
	return `${head}***${initial ? ` ${initial.toLocaleUpperCase('es-AR')}.` : ''}`;
}
