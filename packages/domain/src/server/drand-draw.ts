import { createHash } from 'node:crypto';

/**
 * The winners of one tirada from a drand round (ADR 0026; odd/tasks/draw-room.md
 * T8, S6-S8). Published so anyone can recompute it (scripts/verify-app-draw.mjs
 * does, with no dependencies):
 *
 *   remaining = the candidate coupons, ascending
 *   for i = 0, 1, 2, …
 *     h = SHA-256(utf8("<randomness>:<candidateSha256>:<i>")) read as a 256-bit unsigned integer
 *     n = remaining.length
 *     if h ≥ floor(2^256 / n) × n: reject h and go on with i + 1
 *     else: pick remaining[h mod n] and remove it from remaining
 *   until `count` picks were made or nothing remains
 *
 * `randomness` and `candidateSha256` are the lowercase hex strings that get
 * published. Rejecting the top of the hash space leaves a range that is an
 * exact multiple of n, so every remaining coupon is equally likely at every
 * step (no modulo bias); a rejection is practically impossible for a few
 * thousand coupons (probability below n / 2^256) but is part of the rule.
 * The picks are in the order drawn: the first one goes to the first unit.
 */

const hex64 = /^[0-9a-f]{64}$/;
const space = 1n << 256n;

/** The index `h` picks among `n` remaining candidates, or null when `h` is rejected. */
export function beaconPickIndex(h: bigint, n: number): number | null {
	const size = BigInt(n);
	if (h >= (space / size) * size) return null;
	return Number(h % size);
}

export function drawFromBeacon(input: {
	readonly randomness: string;
	readonly candidateSha256: string;
	/** The candidate coupon numbers, strictly ascending (the published list). */
	readonly candidates: readonly number[];
	readonly count: number;
}): number[] {
	if (!hex64.test(input.randomness)) throw new RangeError('randomness must be 64 lowercase hex characters');
	if (!hex64.test(input.candidateSha256)) throw new RangeError('candidateSha256 must be 64 lowercase hex characters');
	if (!Number.isInteger(input.count) || input.count < 0) throw new RangeError('count must be a non-negative integer');
	if (input.candidates.some((value, index) => !Number.isInteger(value) || (index > 0 && value <= input.candidates[index - 1]!))) {
		throw new RangeError('candidates must be distinct integers in ascending order');
	}
	const remaining = [...input.candidates];
	const picks: number[] = [];
	for (let i = 0; picks.length < input.count && remaining.length > 0; i++) {
		const digest = createHash('sha256').update(`${input.randomness}:${input.candidateSha256}:${i}`, 'utf8').digest('hex');
		const index = beaconPickIndex(BigInt(`0x${digest}`), remaining.length);
		if (index === null) continue;
		picks.push(remaining.splice(index, 1)[0]!);
	}
	return picks;
}
