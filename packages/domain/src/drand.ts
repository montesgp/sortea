/**
 * The public randomness of an in-app tirada (ADR 0026; odd/tasks/draw-room.md
 * T8, S8, L7): the drand quicknet chain of the League of Entropy publishes a
 * BLS-signed round every 3 seconds since its genesis, and its randomness is the
 * SHA-256 of the round's signature. A tirada commits to the first round that
 * does not exist yet, so nobody (the platform included) knows its randomness
 * when the candidate list is fixed.
 */
export const quicknet = {
	chainHash: '52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971',
	/** Unix seconds of round 1. */
	genesisTime: 1_692_803_367,
	/** Seconds between rounds. */
	period: 3,
	/** The chain's BLS12-381 G2 public key; signatures are on G1 (`bls-unchained-g1-rfc9380`). */
	publicKey:
		'83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a',
	scheme: 'bls-unchained-g1-rfc9380'
} as const;

/** The public relays, tried in this order (`DRAND_RELAYS` replaces them). */
export const drandRelays = ['https://api.drand.sh', 'https://api2.drand.sh', 'https://api3.drand.sh', 'https://drand.cloudflare.com'] as const;

/** When a quicknet round is published: genesis + (round − 1) × period. */
export function drandRoundTime(round: number): Date {
	return new Date((quicknet.genesisTime + (round - 1) * quicknet.period) * 1000);
}

/**
 * The first round published strictly after `now`: the one a tirada commits to.
 * At the very instant a round is published it is already known, so the next
 * one is taken.
 */
export function nextDrandRound(now: Date): number {
	const elapsedMs = now.getTime() - quicknet.genesisTime * 1000;
	if (elapsedMs < 0) return 1;
	return Math.floor(elapsedMs / (quicknet.period * 1000)) + 2;
}

/** How long before its round is published a tirada's commitment must be stored (ADR 0026 §2). */
export const DRAND_COMMIT_MARGIN_MS = 1000;

/**
 * The round a tirada commits to: the first one published at least a second
 * after the click, so the commitment is durable before the round exists even
 * when the click lands in the last milliseconds before a round.
 */
export function commitDrandRound(now: Date): number {
	return nextDrandRound(new Date(now.getTime() + DRAND_COMMIT_MARGIN_MS - 1));
}

/** `https://api.drand.sh/<chain hash>/public/<round>`: where anyone reads a round. */
export function drandRoundUrl(relay: string, round: number): string {
	return `${relay.replace(/\/+$/, '')}/${quicknet.chainHash}/public/${round}`;
}
