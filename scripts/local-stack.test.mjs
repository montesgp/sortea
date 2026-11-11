// Run with: node --test scripts (part of `pnpm test`).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { STACK_SERVICES, stackCommand, stackRefusal } from './local-stack.mjs';

const compose = readFileSync(new URL('../docker-compose.yml', import.meta.url), 'utf8');

describe('pnpm db:start and db:stop', () => {
	it('start brings every service of docker-compose.yml up and waits until they are healthy', () => {
		assert.deepEqual(stackCommand('start'), { command: 'docker', args: ['compose', 'up', '--detach', '--wait', ...STACK_SERVICES] });
	});

	it('stop stops the same services and keeps their volumes', () => {
		assert.deepEqual(stackCommand('stop'), { command: 'docker', args: ['compose', 'stop', ...STACK_SERVICES] });
	});

	it('names exactly the services of docker-compose.yml', () => {
		const services = compose.split(/^services:\s*$/m)[1].split(/^\S/m)[0];
		const names = [...services.matchAll(/^ {2}([a-z0-9-]+):\s*$/gm)].map((match) => match[1]);
		assert.deepEqual([...STACK_SERVICES].sort(), names.sort());
	});

	it('binds every published port to 127.0.0.1 only', () => {
		const ports = [...compose.matchAll(/^\s+- '([^']+:\d+)'\s*$/gm)].map((match) => match[1]);
		assert.ok(ports.length >= 5);
		for (const port of ports) assert.match(port, /^127\.0\.0\.1:/);
	});

	it('refuses an unknown action', () => {
		assert.throws(() => stackCommand('down'), /Usage: node scripts\/local-stack\.mjs start\|stop/);
	});
});

describe('stackRefusal', () => {
	it('refuses to start while the Supabase CLI database still holds the ports', () => {
		const message = stackRefusal('start', ['sortea-minio-1', 'supabase_db_sortea']);
		assert.match(message, /supabase_db_sortea is running/);
		assert.match(message, /pnpm db:import-from-supabase --dump-only/);
		assert.match(message, /supabase stop --project-id sortea/);
	});

	it('lets start run when no Supabase database runs, and stop run always', () => {
		assert.equal(stackRefusal('start', ['sortea-minio-1', 'supabase_studio_sortea']), null);
		assert.equal(stackRefusal('start', []), null);
		assert.equal(stackRefusal('stop', ['supabase_db_sortea']), null);
	});
});
