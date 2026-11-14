import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { appDrawCandidateText } from '../src/app-draw';
import { drandRoundTime, nextDrandRound } from '../src/drand';
import { beaconPickIndex, drawFromBeacon } from '../src/server/drand-draw';

// Independent verification probes of odd/tasks/draw-room.md T8 (ADR 0026 §2, §3): the public script
// anyone runs recomputes exactly what the platform drew, the rejection bound keeps every coupon
// equally likely, and the next round is always one nobody knows yet.
type ScriptModule = {
	drawWinners: (input: { randomness: string; candidateSha256: string; candidates: number[]; count: number }) => number[];
	parseCandidates: (text: string) => number[];
};
const scriptUrl = new URL('../../../scripts/verify-app-draw.mjs', import.meta.url);
const script = fileURLToPath(scriptUrl);
const loadScript = () => import(scriptUrl.href) as Promise<ScriptModule>;
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const randomness = 'b22aad4794f7451896f7a371aa46106fd84d919f3f569acd5b2fddf1d1440af3';

describe('verify-app-draw.mjs and drawFromBeacon agree (ADR 0026 §3)', () => {
	it('on 400 pseudo-random vectors, every count up to n + 2', async () => {
		const { drawWinners, parseCandidates } = await loadScript();
		for (let seed = 0; seed < 400; seed++) {
			const n = 1 + (Number.parseInt(sha(`n-${seed}`).slice(0, 4), 16) % 60);
			const pool = Array.from({ length: n * 3 }, (_, i) => i).filter((i) => Number.parseInt(sha(`c-${seed}-${i}`).slice(0, 2), 16) < 85 || i === 0);
			const text = appDrawCandidateText(pool, 4);
			const count = seed % (pool.length + 3);
			const input = { randomness: sha(`r-${seed}`), candidateSha256: sha(text), candidates: pool, count };
			expect(parseCandidates(text)).toEqual(pool);
			const picks = drawFromBeacon(input);
			expect(drawWinners(input)).toEqual(picks);
			expect(new Set(picks).size).toBe(picks.length);
			expect(picks.length).toBe(Math.min(count, pool.length));
			for (const pick of picks) expect(pool).toContain(pick);
		}
	});

	it('the command line prints the pinned vector of the ADR', () => {
		const dir = mkdtempSync(join(tmpdir(), 'verify-app-draw-'));
		try {
			const file = join(dir, 'list.txt');
			writeFileSync(file, appDrawCandidateText([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 4));
			const out = execFileSync(process.execPath, [script, '--candidates', file, '--count', '3', '--randomness', randomness], { encoding: 'utf8' });
			expect(out.trim().split(/\r?\n/)).toEqual([
				'Candidatos: 10, SHA-256 5e8d38ac2d00628d9128bd32cd8a6d4e477c2c8c5a68a3ab8ef6509b569a1df1',
				`Aleatoriedad: ${randomness}`,
				'1. 0002',
				'2. 0005',
				'3. 0004'
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe('rejection bound and next round (ADR 0026 §2, §3)', () => {
	it('accepts exactly floor(2^256 / n) * n values', () => {
		const space = 1n << 256n;
		for (const n of [1, 2, 3, 7, 10, 294, 9999, 10000]) {
			const limit = (space / BigInt(n)) * BigInt(n);
			expect(space - limit < BigInt(n)).toBe(true);
			expect(beaconPickIndex(limit - 1n, n)).toBe(n - 1);
			if (limit < space) expect(beaconPickIndex(limit, n)).toBeNull();
			expect(beaconPickIndex(0n, n)).toBe(0);
		}
	});

	it('nextDrandRound is strictly after now and at most one period ahead, at every millisecond', () => {
		const base = drandRoundTime(1_000_000).getTime();
		for (let ms = -1; ms <= 3001; ms++) {
			const now = base + ms;
			const round = nextDrandRound(new Date(now));
			expect(drandRoundTime(round).getTime()).toBeGreaterThan(now);
			expect(drandRoundTime(round).getTime() - now).toBeLessThanOrEqual(3000);
			expect(drandRoundTime(round - 1).getTime()).toBeLessThanOrEqual(now);
		}
	});
});
