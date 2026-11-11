// Run with: node --test scripts (part of `pnpm test`).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GATE_DATABASE, GATE_DATABASE_BASE, gateSteps, gateTargets } from './gate.mjs';

describe('gateTargets', () => {
	it('uses a throwaway database on the server of DATABASE_URL, administered from its postgres database', () => {
		const { adminUrl, gateUrl, server } = gateTargets('postgresql://postgres:secret@127.0.0.1:54322/postgres?sslmode=disable');
		assert.equal(GATE_DATABASE_BASE, 'sortea_gate');
		assert.equal(GATE_DATABASE, process.env.TEST_DATABASE_SUFFIX ? `sortea_gate_${process.env.TEST_DATABASE_SUFFIX}` : 'sortea_gate');
		assert.equal(new URL(adminUrl).pathname, '/postgres');
		assert.equal(new URL(gateUrl).pathname, `/${GATE_DATABASE}`);
		assert.equal(new URL(gateUrl).password, 'secret');
		assert.equal(server, '127.0.0.1:54322');
		assert.equal(gateTargets('postgresql://u:p@localhost/app').server, 'localhost:5432');
		assert.equal(new URL(gateTargets('postgres://u:p@[::1]:5432/app').gateUrl).hostname, '[::1]');
	});

	it('refuses a server that is not on this machine, without printing the connection string', () => {
		for (const url of ['postgresql://u:hunter2@db.railway.internal:5432/railway', 'postgresql://u:hunter2@10.0.0.4/app', 'postgresql://u:hunter2@postgres/app']) {
			assert.throws(
				() => gateTargets(url),
				(error) => error instanceof Error && /only on a local Postgres/.test(error.message) && !error.message.includes('hunter2')
			);
		}
	});

	it('refuses a missing or malformed DATABASE_URL', () => {
		assert.throws(() => gateTargets(''), /DATABASE_URL/);
		assert.throws(() => gateTargets('not a url'), /DATABASE_URL/);
		assert.throws(() => gateTargets('mysql://u:p@127.0.0.1/app'), /postgres/);
	});
});

describe('gateSteps', () => {
	it('runs what CI runs, then the compiled pre-deploy on the throwaway database', () => {
		const steps = gateSteps({ adminUrl: 'postgresql://a@127.0.0.1/postgres', gateUrl: 'postgresql://a@127.0.0.1/sortea_gate' }, {});
		assert.deepEqual(
			steps.map((step) => step.name),
			['typecheck', 'unit and integration tests', 'script tests', 'build api and worker', 'migrations on a clean database']
		);
		assert.deepEqual(steps[0].command, ['pnpm', 'check']);
		assert.equal(steps[1].env.TEST_DATABASE_ADMIN_URL, 'postgresql://a@127.0.0.1/postgres');
		assert.deepEqual(steps.at(-1).command, ['node', 'apps/api/dist/predeploy.js']);
		assert.equal(steps.at(-1).env.DATABASE_URL, 'postgresql://a@127.0.0.1/sortea_gate');
	});

	it('keeps a TEST_DATABASE_ADMIN_URL already set', () => {
		const steps = gateSteps({ adminUrl: 'postgresql://a@127.0.0.1/postgres', gateUrl: 'x' }, { TEST_DATABASE_ADMIN_URL: 'postgresql://b@localhost/postgres' });
		assert.equal(steps[1].env.TEST_DATABASE_ADMIN_URL, 'postgresql://b@localhost/postgres');
	});
});
