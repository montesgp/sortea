import { describe, expect, it } from 'vitest';
import { appDrawCandidateText, appPrizePendingUnits, commitDrandRound, drandRoundTime, drandRoundUrl, nextDrandRound, prizeMechanisms, quicknet, type SlotAward } from '../src';
import { beaconPickIndex, drawFromBeacon, sha256Hex } from '../src/server';

/**
 * odd/tasks/draw-room.md T8 (S6-S8, L7), ADR 0026: one tirada per prize draws
 * as many winners as the prize has pending units, from the randomness of a
 * drand quicknet round committed before it existed. The picks are a pure
 * function of the round's randomness and the candidate list, so anybody can
 * recompute them (scripts/verify-app-draw.mjs pins the same vector).
 */

/** Quicknet round 1000000, as every relay serves it (recorded 2026-11-14). */
const round1000000 = {
	round: 1_000_000,
	randomness: 'b22aad4794f7451896f7a371aa46106fd84d919f3f569acd5b2fddf1d1440af3',
	signature: '83ad29e4c409f9470fc2ef02f90214df49e02b441a1a241a82d622d9f608ef98fd8b11a029f1bee9d9e83b45088abe72'
};
const tenCoupons = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
const tenSha256 = sha256Hex(appDrawCandidateText(tenCoupons, 4));

describe('quicknet (L7)', () => {
	it('is the League of Entropy chain the decision names', () => {
		expect(quicknet).toMatchObject({
			chainHash: '52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971',
			genesisTime: 1_692_803_367,
			period: 3
		});
	});

	it('publishes round 1 at genesis and one round every 3 seconds', () => {
		expect(drandRoundTime(1).toISOString()).toBe(new Date(1_692_803_367_000).toISOString());
		expect(drandRoundTime(2).getTime()).toBe(1_692_803_370_000);
		expect(drandRoundTime(1_000_000).getTime()).toBe((1_692_803_367 + 999_999 * 3) * 1000);
	});

	it('names the relay address of a round', () => {
		expect(drandRoundUrl('https://api.drand.sh', 1_000_000)).toBe(
			'https://api.drand.sh/52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971/public/1000000'
		);
		expect(drandRoundUrl('https://drand.cloudflare.com/', 7)).toBe('https://drand.cloudflare.com/52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971/public/7');
	});
});

// Independent verification advisory: a click in the last milliseconds before a round must not commit
// a round published before the commitment is durable, so a tirada commits at least a second ahead.
describe('commitDrandRound: the round a tirada commits to', () => {
	it('is published at least one second and at most four seconds after the click, at every millisecond', () => {
		const base = drandRoundTime(1_000_000).getTime();
		for (let ms = -1; ms <= 3001; ms++) {
			const round = commitDrandRound(new Date(base + ms));
			const gap = drandRoundTime(round).getTime() - (base + ms);
			expect(gap).toBeGreaterThanOrEqual(1000);
			expect(gap).toBeLessThanOrEqual(4000);
		}
	});
});

describe('nextDrandRound: the first round published strictly after now', () => {
	const at = (round: number, offsetMs = 0) => new Date(drandRoundTime(round).getTime() + offsetMs);

	it('at the instant a round is published, is the next one', () => {
		expect(nextDrandRound(at(1_000_000))).toBe(1_000_001);
	});

	it('between two rounds, is the coming one', () => {
		expect(nextDrandRound(at(1_000_000, 1))).toBe(1_000_001);
		expect(nextDrandRound(at(1_000_000, 2_999))).toBe(1_000_001);
		expect(nextDrandRound(at(1_000_000, 3_000))).toBe(1_000_002);
	});

	it('is always in the future and at most one period away', () => {
		for (const now of [new Date('2026-11-14T06:39:53.123Z'), new Date('2027-01-01T00:00:00Z'), at(33_945_009, 1_500)]) {
			const round = nextDrandRound(now);
			expect(drandRoundTime(round).getTime()).toBeGreaterThan(now.getTime());
			expect(drandRoundTime(round).getTime() - now.getTime()).toBeLessThanOrEqual(3_000);
		}
	});

	it('before genesis, is round 1', () => {
		expect(nextDrandRound(new Date('2020-01-01T00:00:00Z'))).toBe(1);
	});
});

describe('drawFromBeacon (ADR 0026)', () => {
	const vector = { randomness: round1000000.randomness, candidateSha256: tenSha256, candidates: tenCoupons };

	it('pins a vector: round 1000000 over coupons 0000-0009', () => {
		expect(tenSha256).toBe('5e8d38ac2d00628d9128bd32cd8a6d4e477c2c8c5a68a3ab8ef6509b569a1df1');
		// h0 = SHA-256("<randomness>:<sha>:0") is 0x52778b…96d2, and h0 mod 10 = 2: coupon 0002 first.
		expect(sha256Hex(`${round1000000.randomness}:${tenSha256}:0`)).toBe('52778bf393de9eab88ecaddf5718adac340f035e1a9c9081eaea5ea87c9596d2');
		expect(drawFromBeacon({ ...vector, count: 3 })).toEqual([2, 5, 4]);
	});

	it('is deterministic, and a prefix of a longer draw', () => {
		expect(drawFromBeacon({ ...vector, count: 3 })).toEqual(drawFromBeacon({ ...vector, count: 3 }));
		expect(drawFromBeacon({ ...vector, count: 5 }).slice(0, 3)).toEqual([2, 5, 4]);
	});

	it('draws distinct coupons and stops when none remain', () => {
		const all = drawFromBeacon({ ...vector, count: 12 });
		expect(all).toEqual([2, 5, 4, 3, 1, 6, 0, 9, 7, 8]);
		expect(new Set(all).size).toBe(10);
		expect(drawFromBeacon({ ...vector, count: 0 })).toEqual([]);
		expect(drawFromBeacon({ ...vector, candidates: [], count: 3 })).toEqual([]);
		expect(drawFromBeacon({ ...vector, candidates: [42], count: 3 })).toEqual([42]);
	});

	it('changes with the randomness and with the list hash', () => {
		const other = drawFromBeacon({ ...vector, randomness: '01a8cc2bae3e00cf931fb01063793fb0e120199cb16e772169d5b37cd75afbf2', count: 10 });
		expect(other).not.toEqual(drawFromBeacon({ ...vector, count: 10 }));
		expect(drawFromBeacon({ ...vector, candidateSha256: sha256Hex('x'), count: 10 })).not.toEqual(drawFromBeacon({ ...vector, count: 10 }));
	});

	it('favors no position over many rounds', () => {
		const counts = new Array<number>(7).fill(0);
		const trials = 7_000;
		for (let seed = 0; seed < trials; seed++) {
			const [pick] = drawFromBeacon({ randomness: sha256Hex(`seed-${seed}`), candidateSha256: tenSha256, candidates: [0, 1, 2, 3, 4, 5, 6], count: 1 });
			counts[pick!]!++;
		}
		// Expected 1000 each; 5 standard deviations (~ 5 * 29) is far beyond chance.
		for (const value of counts) expect(Math.abs(value - trials / 7)).toBeLessThan(150);
	});

	it('refuses inputs that are not what gets published', () => {
		expect(() => drawFromBeacon({ ...vector, randomness: 'B22A', count: 1 })).toThrow(/randomness/);
		expect(() => drawFromBeacon({ ...vector, candidateSha256: tenSha256.toUpperCase(), count: 1 })).toThrow(/candidateSha256/);
		expect(() => drawFromBeacon({ ...vector, candidates: [3, 1, 2], count: 1 })).toThrow(/ascending/);
		expect(() => drawFromBeacon({ ...vector, candidates: [1, 1, 2], count: 1 })).toThrow(/ascending/);
		expect(() => drawFromBeacon({ ...vector, count: -1 })).toThrow(/count/);
	});
});

describe('app prizes (T8, S6)', () => {
	it('are a mechanism of their own', () => {
		expect(prizeMechanisms).toEqual(['quiniela', 'manual', 'app']);
	});

	const award = (prizeId: string, slot: number, status: SlotAward['status'], rank = 1): SlotAward & { prizeId: string; slot: number } => ({
		id: `${prizeId}-${slot}-${rank}`,
		role: 'winner',
		rank,
		status,
		fulfillmentStatus: null,
		prizeId,
		slot
	});
	const prizes = [
		{ id: 'moto', mechanism: 'app' as const, quantity: 1 },
		{ id: 'cash', mechanism: 'app' as const, quantity: 5 },
		{ id: 'kit', mechanism: 'manual' as const, quantity: 2 },
		{ id: 'tv', mechanism: 'quiniela' as const, quantity: 1 }
	];

	it('are pending in every unit nobody holds, ascending, in the order given', () => {
		expect(appPrizePendingUnits(prizes, []).map(({ prize, slot }) => `${prize.id}#${slot}`)).toEqual(['moto#1', 'cash#1', 'cash#2', 'cash#3', 'cash#4', 'cash#5']);
	});

	it('leave out held units and void ones, and take back a unit whose winners were all passed over', () => {
		const awards = [award('moto', 1, 'accepted'), award('cash', 1, 'pending_verification'), award('cash', 2, 'declined'), award('cash', 3, 'void'), award('cash', 3, 'declined', 2)];
		expect(appPrizePendingUnits(prizes, awards, [{ prizeId: 'cash', slot: 5 }])).toEqual([
			{ prize: prizes[1], slot: 2, state: 'exhausted' },
			{ prize: prizes[1], slot: 3, state: 'exhausted' },
			{ prize: prizes[1], slot: 4, state: 'pending' }
		]);
	});
});

describe('beaconPickIndex: rejection sampling keeps every index equally likely', () => {
	const space = 1n << 256n;

	it('takes h mod n below the largest multiple of n', () => {
		expect(beaconPickIndex(0n, 10)).toBe(0);
		expect(beaconPickIndex(17n, 10)).toBe(7);
		const limit = (space / 10n) * 10n;
		expect(beaconPickIndex(limit - 1n, 10)).toBe(Number((limit - 1n) % 10n));
	});

	it('rejects h at or above that multiple', () => {
		const limit = (space / 10n) * 10n;
		expect(beaconPickIndex(limit, 10)).toBeNull();
		expect(beaconPickIndex(space - 1n, 10)).toBeNull();
		// A power of two divides 2^256: nothing is ever rejected.
		expect(beaconPickIndex(space - 1n, 8)).toBe(7);
	});
});
