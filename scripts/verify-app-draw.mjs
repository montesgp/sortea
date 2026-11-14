#!/usr/bin/env node
// Recomputes the winners of an in-app tirada of an `app` prize (ADR 0026,
// odd/tasks/draw-room.md T8) from public data only, with no dependencies:
//
//   node scripts/verify-app-draw.mjs --candidates <file.txt> --count <units> --round <drand round>
//   node scripts/verify-app-draw.mjs --candidates <file.txt> --count <units> --randomness <hex>
//
// <file.txt> is the tirada's candidate list as the transparency page serves it
// ("Descargar la lista de cupones"); --count is how many units the tirada drew;
// --round reads the drand quicknet round from a relay (--relay to pick another),
// --randomness takes the round's randomness as published instead. Prints the
// list's SHA-256, the randomness and the winners in order: the first one goes to
// the first unit of the tirada. It checks that the relay's randomness is the
// SHA-256 of the round's signature; the BLS signature itself is checked by any
// drand client, e.g. https://drand.love/developer/clients/.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const quicknetChainHash = '52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971';
const space = 1n << 256n;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** The candidate coupon numbers of the published text: one per line, ascending, no final newline. */
export function parseCandidates(text) {
	if (text === '') return [];
	const numbers = text.split('\n').map((line) => {
		if (!/^\d+$/.test(line)) throw new Error(`Not a coupon number: ${JSON.stringify(line)}`);
		return Number(line);
	});
	for (let index = 1; index < numbers.length; index++) {
		if (numbers[index] <= numbers[index - 1]) throw new Error('The coupons must be in ascending order, without repeats');
	}
	return numbers;
}

/**
 * The published algorithm: for i = 0, 1, 2…, h = SHA-256("<randomness>:<candidateSha256>:<i>")
 * as a 256-bit integer; with n coupons remaining, h ≥ floor(2^256 / n) × n is rejected, else
 * the coupon at h mod n is picked and removed; until `count` picks or none remain.
 */
export function drawWinners({ randomness, candidateSha256, candidates, count }) {
	const remaining = [...candidates];
	const picks = [];
	for (let i = 0; picks.length < count && remaining.length > 0; i++) {
		const h = BigInt(`0x${sha256(`${randomness}:${candidateSha256}:${i}`)}`);
		const n = BigInt(remaining.length);
		if (h >= (space / n) * n) continue;
		picks.push(remaining.splice(Number(h % n), 1)[0]);
	}
	return picks;
}

/** Reads a quicknet round and checks that its randomness is SHA-256 of its signature. */
export async function fetchRandomness(round, relay = 'https://api.drand.sh', fetcher = fetch) {
	const response = await fetcher(`${relay.replace(/\/+$/, '')}/${quicknetChainHash}/public/${round}`);
	if (!response.ok) throw new Error(`The relay answered HTTP ${response.status}${response.status === 425 ? ': that round is not published yet' : ''}`);
	const beacon = await response.json();
	if (beacon.round !== round) throw new Error(`The relay answered round ${beacon.round}, not ${round}`);
	if (sha256(Buffer.from(beacon.signature, 'hex')) !== beacon.randomness) throw new Error('The randomness is not SHA-256 of the signature');
	return beacon.randomness;
}

const knownOptions = new Set(['candidates', 'count', 'round', 'relay', 'randomness']);

function options(argv) {
	const values = {};
	for (let index = 0; index < argv.length; index += 2) {
		const name = argv[index];
		if (!name?.startsWith('--') || argv[index + 1] === undefined) throw new Error(`Unexpected argument ${name}`);
		if (!knownOptions.has(name.slice(2))) throw new Error(`Unknown option ${name}`);
		values[name.slice(2)] = argv[index + 1];
	}
	// One source of randomness, never a label that does not match it.
	if (values.round && values.randomness) throw new Error('Give either --round or --randomness, not both');
	if (values.relay && !values.round) throw new Error('Use --relay only with --round');
	return values;
}

export async function main(argv, { fetcher = fetch, write = (line) => console.log(line) } = {}) {
	const args = options(argv);
	if (!args.candidates || !args.count || (!args.round && !args.randomness)) {
		throw new Error('Usage: verify-app-draw.mjs --candidates <file.txt> --count <units> (--round <drand round> [--relay <url>] | --randomness <hex>)');
	}
	const bytes = readFileSync(args.candidates);
	const text = bytes.toString('utf8');
	const candidates = parseCandidates(text);
	const digits = text.split('\n')[0]?.length ?? 4;
	const candidateSha256 = sha256(bytes);
	const randomness = (args.randomness ?? (await fetchRandomness(Number(args.round), args.relay, fetcher))).toLowerCase();
	if (!/^[0-9a-f]{64}$/.test(randomness)) throw new Error('The randomness must be 64 hexadecimal characters');
	const count = Number(args.count);
	if (!Number.isInteger(count) || count < 1) throw new Error('--count must be a whole number of units');
	write(`Candidatos: ${candidates.length}, SHA-256 ${candidateSha256}`);
	write(`Aleatoriedad${args.round ? ` (ronda ${args.round} de drand)` : ''}: ${randomness}`);
	drawWinners({ randomness, candidateSha256, candidates, count }).forEach((entryNumber, index) => write(`${index + 1}. ${String(entryNumber).padStart(digits, '0')}`));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	main(process.argv.slice(2)).catch((error) => {
		console.error(error.message);
		process.exit(1);
	});
}
