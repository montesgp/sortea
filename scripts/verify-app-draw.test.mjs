// Run with: node --test scripts (part of `pnpm test`).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { drawWinners, main, parseCandidates, quicknetChainHash } from './verify-app-draw.mjs';

// The vector of packages/domain/test/drand-draw.test.ts: quicknet round 1000000 over coupons 0000-0009.
const round1000000 = {
	round: 1000000,
	randomness: 'b22aad4794f7451896f7a371aa46106fd84d919f3f569acd5b2fddf1d1440af3',
	signature: '83ad29e4c409f9470fc2ef02f90214df49e02b441a1a241a82d622d9f608ef98fd8b11a029f1bee9d9e83b45088abe72'
};
const tenCoupons = '0000\n0001\n0002\n0003\n0004\n0005\n0006\n0007\n0008\n0009';
const tenSha256 = '5e8d38ac2d00628d9128bd32cd8a6d4e477c2c8c5a68a3ab8ef6509b569a1df1';
const script = fileURLToPath(new URL('./verify-app-draw.mjs', import.meta.url));

async function withFile(text, run) {
	const directory = mkdtempSync(join(tmpdir(), 'sortea-verify-app-draw-'));
	try {
		const path = join(directory, 'cupones.txt');
		writeFileSync(path, text);
		return await run(path);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

describe('verify-app-draw (ADR 0026)', () => {
	it('gives the domain vector', () => {
		assert.deepEqual(drawWinners({ randomness: round1000000.randomness, candidateSha256: tenSha256, candidates: parseCandidates(tenCoupons), count: 3 }), [2, 5, 4]);
		assert.deepEqual(drawWinners({ randomness: round1000000.randomness, candidateSha256: tenSha256, candidates: parseCandidates(tenCoupons), count: 12 }), [2, 5, 4, 3, 1, 6, 0, 9, 7, 8]);
	});

	it('prints the hash, the randomness and the winners from a file and --randomness, with no network', async () => {
		await withFile(tenCoupons, (path) => {
			const run = spawnSync(process.execPath, [script, '--candidates', path, '--count', '3', '--randomness', round1000000.randomness], { encoding: 'utf8' });
			assert.equal(run.status, 0, run.stderr);
			assert.equal(run.stdout, `Candidatos: 10, SHA-256 ${tenSha256}\nAleatoriedad: ${round1000000.randomness}\n1. 0002\n2. 0005\n3. 0004\n`);
		});
	});

	it('reads the round from the relay and checks its randomness', async () => {
		const asked = [];
		const relay = (body, status = 200) => async (url) => {
			asked.push(url);
			return new Response(JSON.stringify(body), { status });
		};
		await withFile(tenCoupons, async (path) => {
			const lines = [];
			await main(['--candidates', path, '--count', '2', '--round', '1000000'], { fetcher: relay(round1000000), write: (line) => lines.push(line) });
			assert.deepEqual(lines, [`Candidatos: 10, SHA-256 ${tenSha256}`, `Aleatoriedad (ronda 1000000 de drand): ${round1000000.randomness}`, '1. 0002', '2. 0005']);
			assert.deepEqual(asked, [`https://api.drand.sh/${quicknetChainHash}/public/1000000`]);
			await assert.rejects(main(['--candidates', path, '--count', '2', '--round', '1000000'], { fetcher: relay({ ...round1000000, randomness: '00'.repeat(32) }), write: () => {} }), /not SHA-256 of the signature/);
			await assert.rejects(main(['--candidates', path, '--count', '2', '--round', '99999999'], { fetcher: relay('Requested future beacon', 425), write: () => {} }), /not published yet/);
		});
	});

	// Independent verification blocker: --round was silently ignored next to --randomness and still labelled the output.
	it('refuses --round with --randomness, --relay without --round, and unknown options', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'vad-'));
		try {
			const file = join(dir, 'l.txt');
			writeFileSync(file, '0000\n0001\n0002');
			const r = 'b22aad4794f7451896f7a371aa46106fd84d919f3f569acd5b2fddf1d1440af3';
			const quiet = { write: () => {} };
			await assert.rejects(main(['--candidates', file, '--count', '1', '--round', '1000001', '--randomness', r], quiet), /either --round or --randomness/);
			await assert.rejects(main(['--candidates', file, '--count', '1', '--randomness', r, '--relay', 'https://api2.drand.sh'], quiet), /--relay only with --round/);
			await assert.rejects(main(['--candidates', file, '--count', '1', '--randomness', r, '--relya', 'x'], quiet), /Unknown option --relya/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('refuses a list that is not the published format', () => {
		assert.throws(() => parseCandidates('0002\n0001'), /ascending/);
		assert.throws(() => parseCandidates('0001\n0002\n'), /Not a coupon number/);
		assert.throws(() => parseCandidates('0001\r\n0002'), /Not a coupon number/);
	});
});
