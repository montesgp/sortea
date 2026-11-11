// Run with: node --test scripts (part of `pnpm test`).
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { build } from 'esbuild';
import { externalPackages, packageName } from './bundle.mjs';

describe('packageName', () => {
	it('is the package of an import, scoped or not', () => {
		assert.equal(packageName('zod'), 'zod');
		assert.equal(packageName('drizzle-orm/postgres-js/migrator'), 'drizzle-orm');
		assert.equal(packageName('@aws-sdk/client-s3'), '@aws-sdk/client-s3');
		assert.equal(packageName('@fastify/rate-limit/sub'), '@fastify/rate-limit');
	});
});

describe('externalPackages', () => {
	const dir = mkdtempSync(join(tmpdir(), 'sortea-bundle-'));
	after(() => rmSync(dir, { recursive: true, force: true }));
	const entry = join(dir, 'entry.js');
	writeFileSync(entry, "import { z } from 'zod';\nimport postgres from 'postgres';\nimport { join } from 'node:path';\nexport { z, postgres, join };\n");
	const bundle = (dependencies) => build({ entryPoints: [entry], bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent', plugins: [externalPackages(dependencies)] });

	it('keeps declared packages and Node built-ins as imports', async () => {
		const result = await bundle(['zod', 'postgres']);
		const code = result.outputFiles[0].text;
		assert.match(code, /from "zod"/);
		assert.match(code, /from "postgres"/);
		assert.match(code, /from "node:path"/);
	});

	it('fails the build on a package the app does not declare, since its image would not install it', async () => {
		await assert.rejects(bundle(['zod']), (error) => error.errors.some((e) => /postgres is imported .* but is not in the app's dependencies/.test(e.text)));
	});
});
