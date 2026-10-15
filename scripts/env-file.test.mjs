// Run with: node --test scripts (part of `pnpm test`).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { buildEnvFile, effectiveEnvValue, parseEnv, parseEnvValue } from './env-file.mjs';

describe('.env parsing matches Node --env-file', () => {
	const sample = ['A=a#b', "B='single # x'", 'C="dq"  # trailing', 'D=  spaced  ', 'E=', 'F=plain value # note', 'G=postgresql://u:p@127.0.0.1:54322/postgres'].join('\n');

	it('applies the quote and comment rules', () => {
		assert.deepEqual(parseEnv(sample).values, {
			A: 'a',
			B: 'single # x',
			C: 'dq',
			D: 'spaced',
			E: '',
			F: 'plain value',
			G: 'postgresql://u:p@127.0.0.1:54322/postgres'
		});
	});

	it('agrees with Node itself on the same file', () => {
		const directory = mkdtempSync(join(tmpdir(), 'sortea-env-'));
		try {
			const path = join(directory, 'sample.env');
			writeFileSync(path, sample);
			const keys = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
			const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !keys.includes(key)));
			const node = spawnSync(process.execPath, [`--env-file=${path}`, '-e', `console.log(JSON.stringify(Object.fromEntries(${JSON.stringify(keys)}.map((k) => [k, process.env[k]]))))`], {
				encoding: 'utf8',
				env: environment
			});
			assert.equal(node.status, 0, node.stderr);
			assert.deepEqual(parseEnv(sample).values, JSON.parse(node.stdout));
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it('keeps a quoted value intact even when it contains the other quote', () => {
		assert.equal(parseEnvValue(`"it's # fine" # comment`), "it's # fine");
	});

	it('lets the shell environment win over the file', () => {
		assert.equal(effectiveEnvValue('API_PORT', { API_PORT: '3001' }, { API_PORT: '4001' }), '4001');
		assert.equal(effectiveEnvValue('API_PORT', { API_PORT: '3001' }, {}), '3001');
		assert.equal(effectiveEnvValue('API_PORT', null, {}), '');
	});
});

describe('setup:env refresh', () => {
	const template = ['# comment', 'DATABASE_URL=', 'SECRETS_KEY_RING=', 'LOOKUP_PEPPER=', 'EMAIL_PROVIDER=smtp', 'SEED_ADMIN_PASSWORD=', 'RESEND_API_KEY='].join('\n');
	const fromSupabase = { DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:54322/postgres' };
	const generators = {
		SECRETS_KEY_RING: () => 'v1:NEW',
		LOOKUP_PEPPER: () => 'new-pepper',
		SEED_ADMIN_PASSWORD: () => 'dev-new'
	};

	it('writes fresh secrets when there is no .env', () => {
		const result = buildEnvFile({ template, existing: null, fromSupabase, generators });
		const { values } = parseEnv(result.text);
		assert.equal(values.DATABASE_URL, fromSupabase.DATABASE_URL);
		assert.equal(values.SECRETS_KEY_RING, 'v1:NEW');
		assert.equal(values.EMAIL_PROVIDER, 'smtp');
		assert.deepEqual(result.generated.sort(), ['LOOKUP_PEPPER', 'SECRETS_KEY_RING', 'SEED_ADMIN_PASSWORD']);
	});

	it('keeps existing secrets and edits, refreshes Supabase settings and generates only what is missing', () => {
		const existing = parseEnv(
			['DATABASE_URL=postgresql://stale@127.0.0.1:1/old', 'SECRETS_KEY_RING=v1:KEEP', 'EMAIL_PROVIDER=log', "SEED_ADMIN_PASSWORD='p#ss word'", 'MY_FLAG="x # y"'].join('\n')
		);
		const result = buildEnvFile({ template, existing, fromSupabase, generators });
		const { values } = parseEnv(result.text);
		assert.equal(values.DATABASE_URL, fromSupabase.DATABASE_URL);
		assert.equal(values.SECRETS_KEY_RING, 'v1:KEEP');
		assert.equal(values.EMAIL_PROVIDER, 'log');
		assert.equal(values.LOOKUP_PEPPER, 'new-pepper');
		// Quoted values survive with their quotes, so they still parse the same.
		assert.equal(values.SEED_ADMIN_PASSWORD, 'p#ss word');
		assert.equal(values.MY_FLAG, 'x # y');
		assert.deepEqual(result.generated, ['LOOKUP_PEPPER']);
	});

	it('is stable when run twice', () => {
		const once = buildEnvFile({ template, existing: null, fromSupabase, generators }).text;
		const twice = buildEnvFile({ template, existing: parseEnv(once), fromSupabase, generators }).text;
		assert.equal(twice, once);
	});
});
