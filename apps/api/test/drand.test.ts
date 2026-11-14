import { describe, expect, it } from 'vitest';
import { createDrandClient, parseRelays, verifyBeacon } from '../src/lib/drand';

/**
 * The beacon client of odd/tasks/draw-room.md T8 (ADR 0026): a quicknet round is
 * trusted only with a valid BLS signature for that round and randomness equal to
 * SHA-256 of the signature. The fixture is a real round, recorded once from
 * https://api.drand.sh/52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971/public/1000000
 * (2026-11-14); no test touches the network.
 */
const round1000000 = {
	round: 1_000_000,
	randomness: 'b22aad4794f7451896f7a371aa46106fd84d919f3f569acd5b2fddf1d1440af3',
	signature: '83ad29e4c409f9470fc2ef02f90214df49e02b441a1a241a82d622d9f608ef98fd8b11a029f1bee9d9e83b45088abe72'
};
const chain = '52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971';

/** A fake `fetch` answering per relay origin; records the URLs asked. */
function relays(answers: Record<string, (signal: AbortSignal) => Promise<Response>>) {
	const asked: string[] = [];
	const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		asked.push(url);
		const answer = answers[new URL(url).origin];
		if (!answer) throw new TypeError('fetch failed');
		return answer(init!.signal!);
	}) as typeof fetch;
	return { fetcher, asked };
}
const json = (body: unknown) => async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const future = async () => new Response('Requested future beacon', { status: 425 });

describe('verifyBeacon', () => {
	it('accepts the recorded quicknet round', () => {
		expect(verifyBeacon(1_000_000, round1000000)).toBe(true);
	});

	it('refuses it as another round', () => {
		expect(verifyBeacon(999_999, round1000000)).toBe(false);
		expect(verifyBeacon(1_000_001, round1000000)).toBe(false);
	});

	it('refuses a randomness that is not SHA-256 of the signature', () => {
		expect(verifyBeacon(1_000_000, { ...round1000000, randomness: '01a8cc2bae3e00cf931fb01063793fb0e120199cb16e772169d5b37cd75afbf2' })).toBe(false);
	});

	it('refuses a tampered signature, also one recomputed into the randomness', async () => {
		const { createHash } = await import('node:crypto');
		const signature = `${round1000000.signature.slice(0, -2)}73`;
		const randomness = createHash('sha256').update(Buffer.from(signature, 'hex')).digest('hex');
		expect(verifyBeacon(1_000_000, { signature, randomness })).toBe(false);
		expect(verifyBeacon(1_000_000, { signature: 'zz', randomness })).toBe(false);
	});
});

describe('createDrandClient', () => {
	it('reads the round from the first relay that has a valid one', async () => {
		const { fetcher, asked } = relays({
			'https://one.test': future,
			'https://two.test': json({ ...round1000000, randomness: '00'.repeat(32) }),
			'https://three.test': json(round1000000)
		});
		const errors: string[] = [];
		const client = createDrandClient({ relays: ['https://one.test', 'https://two.test/', 'https://three.test', 'https://four.test'], fetch: fetcher, onRelayError: (relay, reason) => errors.push(`${relay} ${reason}`) });
		expect(await client.fetchRound(1_000_000)).toEqual(round1000000);
		expect(asked).toEqual([`https://one.test/${chain}/public/1000000`, `https://two.test/${chain}/public/1000000`, `https://three.test/${chain}/public/1000000`]);
		// "Not yet" is not an error; a wrong beacon is.
		expect(errors).toEqual(['https://two.test/ invalid beacon']);
	});

	it('answers null when no relay has it yet or every one fails', async () => {
		const { fetcher } = relays({ 'https://one.test': future, 'https://two.test': async () => new Response('', { status: 404 }), 'https://three.test': async () => new Response('', { status: 500 }) });
		const client = createDrandClient({ relays: ['https://one.test', 'https://two.test', 'https://three.test', 'https://down.test'], fetch: fetcher });
		expect(await client.fetchRound(1_000_000)).toBeNull();
	});

	it('gives up on a relay that does not answer in time', async () => {
		const hang = (signal: AbortSignal) => new Promise<Response>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
		const { fetcher } = relays({ 'https://slow.test': hang, 'https://fast.test': json(round1000000) });
		const client = createDrandClient({ relays: ['https://slow.test', 'https://fast.test'], fetch: fetcher, relayTimeoutMs: 50 });
		const started = Date.now();
		expect(await client.fetchRound(1_000_000)).toEqual(round1000000);
		expect(Date.now() - started).toBeLessThan(2_000);
	});

	it('refuses a body of another round', async () => {
		const { fetcher } = relays({ 'https://one.test': json({ ...round1000000, round: 1_000_001 }) });
		expect(await createDrandClient({ relays: ['https://one.test'], fetch: fetcher }).fetchRound(1_000_000)).toBeNull();
	});
});

describe('DRAND_RELAYS', () => {
	it('defaults to the public relays, in order', () => {
		expect(parseRelays(undefined)).toEqual(['https://api.drand.sh', 'https://api2.drand.sh', 'https://api3.drand.sh', 'https://drand.cloudflare.com']);
		expect(parseRelays(' ')).toEqual(parseRelays(undefined));
	});

	it('is replaced by a comma-separated list', () => {
		expect(parseRelays('https://drand.cloudflare.com, https://api.drand.sh')).toEqual(['https://drand.cloudflare.com', 'https://api.drand.sh']);
	});
});

describe('the deadline of one read', () => {
	it('asks no relay once it has passed', async () => {
		const { fetcher, asked } = relays({ 'https://one.test': json(round1000000) });
		expect(await createDrandClient({ relays: ['https://one.test'], fetch: fetcher }).fetchRound(1_000_000, Date.now() - 1)).toBeNull();
		expect(asked).toEqual([]);
	});
});
