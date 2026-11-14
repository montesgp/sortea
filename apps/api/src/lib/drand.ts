import { createHash } from 'node:crypto';
import { bls12_381 } from '@noble/curves/bls12-381.js';
import { drandRelays, drandRoundUrl, quicknet } from '@sortea/domain';

/**
 * The drand quicknet beacon (ADR 0026; odd/tasks/draw-room.md T8, L7). A round
 * is read from the public relays in order and trusted only once verified here:
 * its BLS signature against the chain's public key (`bls-unchained-g1-rfc9380`:
 * the message is SHA-256 of the round as 8 bytes big-endian, hashed to G1 with
 * the RFC 9380 suite below), and its randomness equal to SHA-256 of the
 * signature. A relay is a cache, never a source of trust: a relay that answers
 * a wrong beacon is skipped like one that is down.
 */

/** A verified quicknet round. Hex strings are lowercase. */
export interface Beacon {
	round: number;
	signature: string;
	randomness: string;
}

/**
 * Reads one round; null while it is not published yet or no relay answered a valid one in time.
 * `deadline` (epoch milliseconds) shortens the relays' timeouts so the whole call ends by then.
 */
export interface DrandClient {
	readonly relays: readonly string[];
	fetchRound(round: number, deadline?: number): Promise<Beacon | null>;
}

const g1Dst = 'BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_';
const publicKey = Buffer.from(quicknet.publicKey, 'hex');

/** Whether `beacon` is quicknet's round `round`: signature valid for that round and randomness derived from it. */
export function verifyBeacon(round: number, beacon: { signature: string; randomness: string }): boolean {
	if (!/^[0-9a-f]{96}$/.test(beacon.signature) || !/^[0-9a-f]{64}$/.test(beacon.randomness)) return false;
	const signature = Buffer.from(beacon.signature, 'hex');
	if (createHash('sha256').update(signature).digest('hex') !== beacon.randomness) return false;
	const roundBytes = Buffer.alloc(8);
	roundBytes.writeBigUInt64BE(BigInt(round));
	const message = createHash('sha256').update(roundBytes).digest();
	try {
		return bls12_381.shortSignatures.verify(signature, bls12_381.shortSignatures.hash(message, g1Dst), publicKey);
	} catch {
		// A signature that is not a point of G1 is as invalid as a wrong one.
		return false;
	}
}

/** `DRAND_RELAYS` (comma-separated origins) or the public relays. */
export function parseRelays(value: string | undefined): string[] {
	const relays = (value ?? '')
		.split(',')
		.map((relay) => relay.trim())
		.filter(Boolean);
	return relays.length > 0 ? relays : [...drandRelays];
}

/**
 * Each relay gets `relayTimeoutMs`; a round not yet published (HTTP 425 "Requested future beacon"
 * on drand's relays, 404 on Cloudflare's), an error, a timeout or an invalid beacon moves on to the
 * next relay. The caller decides how long to keep asking.
 */
export function createDrandClient(options: { relays: readonly string[]; fetch?: typeof fetch; relayTimeoutMs?: number; onRelayError?: (relay: string, reason: string) => void }): DrandClient {
	const doFetch = options.fetch ?? fetch;
	const timeout = options.relayTimeoutMs ?? 2_000;
	return {
		relays: options.relays,
		async fetchRound(round, deadline) {
			for (const relay of options.relays) {
				const budget = deadline === undefined ? timeout : Math.min(timeout, deadline - Date.now());
				if (budget <= 0) break;
				try {
					const response = await doFetch(drandRoundUrl(relay, round), { signal: AbortSignal.timeout(budget), headers: { accept: 'application/json' } });
					if (!response.ok) {
						// Not published yet, or the relay is unwell: either way the next relay may have it.
						if (response.status !== 425 && response.status !== 404) options.onRelayError?.(relay, `HTTP ${response.status}`);
						continue;
					}
					const body = (await response.json()) as { round?: unknown; signature?: unknown; randomness?: unknown };
					if (body.round !== round || typeof body.signature !== 'string' || typeof body.randomness !== 'string') {
						options.onRelayError?.(relay, 'unexpected body');
						continue;
					}
					const beacon = { round, signature: body.signature.toLowerCase(), randomness: body.randomness.toLowerCase() };
					if (!verifyBeacon(round, beacon)) {
						options.onRelayError?.(relay, 'invalid beacon');
						continue;
					}
					return beacon;
				} catch (error) {
					options.onRelayError?.(relay, error instanceof Error ? error.name : 'error');
				}
			}
			return null;
		}
	};
}
