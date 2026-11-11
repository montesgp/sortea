// The local gate that stands in for CI while GitHub Actions is off (README,
// "Deploy", "Branches"): the same checks as .github/workflows/ci.yml, then
// the compiled pre-deploy against a clean database.
//
//   pnpm gate
//
// It creates the throwaway database `sortea_gate` on the server of
// DATABASE_URL (from the environment or .env), refuses any server that is
// not on this machine, and drops the database at the end, pass or fail. It
// never writes to the DATABASE_URL database itself.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { effectiveEnvValue, readEnvFile } from './env-file.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const GATE_DATABASE_BASE = 'sortea_gate';
// TEST_DATABASE_SUFFIX (README, "Tests") keeps gates of several checkouts apart.
const suffix = process.env.TEST_DATABASE_SUFFIX;
if (suffix && !/^[a-z0-9_]+$/.test(suffix)) throw new Error('TEST_DATABASE_SUFFIX must use lowercase letters, digits and underscores');
export const GATE_DATABASE = suffix ? `${GATE_DATABASE_BASE}_${suffix}` : GATE_DATABASE_BASE;
const LOCAL_HOSTS = ['127.0.0.1', 'localhost', '[::1]'];

/** The admin and gate connection strings on the server of `databaseUrl`; `server` is safe to print. */
export function gateTargets(databaseUrl) {
	let url;
	try {
		url = new URL(databaseUrl);
	} catch {
		throw new Error('Set DATABASE_URL (in .env or the environment) to the local Postgres.');
	}
	if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') throw new Error('DATABASE_URL must be a postgres:// or postgresql:// connection string.');
	if (!LOCAL_HOSTS.includes(url.hostname)) throw new Error(`The gate runs only on a local Postgres (127.0.0.1, localhost or ::1), not ${url.hostname}.`);
	const at = (database) => Object.assign(new URL(url), { pathname: `/${database}` }).toString();
	return { adminUrl: at('postgres'), gateUrl: at(GATE_DATABASE), server: `${url.hostname}:${url.port || '5432'}` };
}

export function gateSteps({ adminUrl, gateUrl }, environment = process.env) {
	const testAdmin = environment.TEST_DATABASE_ADMIN_URL || adminUrl;
	return [
		{ name: 'typecheck', command: ['pnpm', 'check'], env: {} },
		{ name: 'unit and integration tests', command: ['pnpm', '-r', '--workspace-concurrency=1', 'test'], env: { TEST_DATABASE_ADMIN_URL: testAdmin } },
		{ name: 'script tests', command: ['pnpm', 'test:scripts'], env: {} },
		{ name: 'build api and worker', command: ['pnpm', '--filter', '@sortea/api', '--filter', '@sortea/worker', 'build'], env: {} },
		// The release path: the bundle Railway runs before each deploy, on a database with no schema.
		{ name: 'migrations on a clean database', command: ['node', 'apps/api/dist/predeploy.js'], env: { DATABASE_URL: gateUrl, PREMIGRATE_BACKUP: 'false' } }
	];
}

async function admin(adminUrl, statement) {
	const postgres = createRequire(join(root, 'packages/db/package.json'))('postgres');
	const sql = postgres(adminUrl, { max: 1, onnotice: () => {} });
	try {
		await sql.unsafe(statement);
	} finally {
		await sql.end();
	}
}

async function main() {
	const targets = gateTargets(effectiveEnvValue('DATABASE_URL', readEnvFile(join(root, '.env'))));
	console.log(`gate: throwaway database ${GATE_DATABASE} on ${targets.server}`);
	await admin(targets.adminUrl, `drop database if exists ${GATE_DATABASE} with (force)`);
	await admin(targets.adminUrl, `create database ${GATE_DATABASE}`);
	const results = [];
	try {
		for (const step of gateSteps(targets)) {
			console.log(`\ngate: ${step.name} (${step.command.join(' ')})`);
			const started = Date.now();
			const run = spawnSync(step.command[0], step.command.slice(1), { cwd: root, stdio: 'inherit', shell: process.platform === 'win32', env: { ...process.env, ...step.env } });
			const ok = run.status === 0;
			results.push(`${ok ? 'ok  ' : 'FAIL'} ${step.name} (${Math.round((Date.now() - started) / 1000)} s)`);
			if (!ok) break;
		}
	} finally {
		await admin(targets.adminUrl, `drop database if exists ${GATE_DATABASE} with (force)`);
	}
	console.log(`\ngate summary:\n  ${results.join('\n  ')}`);
	const passed = results.length === gateSteps(targets).length && results.every((line) => line.startsWith('ok'));
	console.log(passed ? 'gate: passed' : 'gate: FAILED');
	process.exitCode = passed ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	main().catch((error) => {
		console.error(`gate: ${error instanceof Error ? error.message : error}`);
		process.exitCode = 1;
	});
}
