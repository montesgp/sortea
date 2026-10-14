// Local environment checks and small helpers for scripts/dev/run-all.bat.
//
//   node scripts/dev/doctor.mjs [check] [--scope=tooling|all]   report every prerequisite; exit 1 on a failure
//   node scripts/dev/doctor.mjs deps-fresh                      exit 0 when node_modules matches pnpm-lock.yaml
//   node scripts/dev/doctor.mjs supabase-running                exit 0 when the local Supabase database container runs
//   node scripts/dev/doctor.mjs wait <url>... [--timeout=120]   exit 0 once every URL answers 2xx
//   node scripts/dev/doctor.mjs env <KEY>                       print a value from .env (empty when absent)
//   node scripts/dev/doctor.mjs browser                         print a system Chrome/Edge path for Playwright
//
// It only reads: it never installs, starts or writes anything.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const at = (...parts) => join(root, ...parts);
const pkg = JSON.parse(readFileSync(at('package.json'), 'utf8'));

/** Settings the API, worker and web refuse to start without. */
const requiredEnv = [
	'DATABASE_URL',
	'SUPABASE_URL',
	'SUPABASE_PUBLISHABLE_KEY',
	'SUPABASE_SECRET_KEY',
	'SECRETS_KEY_RING',
	'LOOKUP_PEPPER',
	'PSEUDONYM_PEPPER',
	'INTERNAL_API_TOKEN',
	'API_INTERNAL_URL',
	'API_PUBLIC_URL',
	'WEB_FALLBACK_ORIGIN',
	'EMAIL_FROM_DOMAIN'
];
const localHosts = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function run(command, args, timeout = 20_000) {
	const result = spawnSync(command, args, { encoding: 'utf8', shell: process.platform === 'win32', timeout, windowsHide: true });
	return { ok: result.status === 0, out: (result.stdout ?? '').trim() };
}

function parseVersion(text) {
	const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(text ?? '');
	return match ? match.slice(1).map((part) => Number(part ?? 0)) : null;
}

function atLeast(version, minimum) {
	for (let index = 0; index < 3; index++) {
		if ((version[index] ?? 0) !== (minimum[index] ?? 0)) return (version[index] ?? 0) > (minimum[index] ?? 0);
	}
	return true;
}

export function readEnvFile(path = at('.env')) {
	if (!existsSync(path)) return null;
	const values = {};
	for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
		const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
		if (match) values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2').trim();
	}
	return values;
}

function templateKeys() {
	return [...readFileSync(at('env.template'), 'utf8').matchAll(/^([A-Z0-9_]+)=/gm)].map((match) => match[1]);
}

export function depsFresh() {
	const installed = at('node_modules', '.pnpm', 'lock.yaml');
	return existsSync(installed) && statSync(installed).mtimeMs >= statSync(at('pnpm-lock.yaml')).mtimeMs;
}

function supabaseProjectId() {
	const match = /^project_id\s*=\s*"([^"]+)"/m.exec(readFileSync(at('supabase', 'config.toml'), 'utf8'));
	return match?.[1] ?? 'sortea';
}

export function supabaseRunning() {
	const { ok, out } = run('docker', ['inspect', '-f', '{{.State.Running}}', `supabase_db_${supabaseProjectId()}`]);
	return ok && out === 'true';
}

function portOpen(port, host = '127.0.0.1', timeout = 1_500) {
	return new Promise((resolve) => {
		const socket = connect({ port, host });
		const done = (open) => {
			socket.destroy();
			resolve(open);
		};
		socket.setTimeout(timeout, () => done(false));
		socket.once('connect', () => done(true));
		socket.once('error', () => done(false));
	});
}

async function answers(url, timeout = 3_000) {
	try {
		const response = await fetch(url, { signal: AbortSignal.timeout(timeout), redirect: 'manual' });
		return response.status >= 200 && response.status < 400;
	} catch {
		return false;
	}
}

export function systemBrowser() {
	const candidates = [
		process.env.PW_CHROMIUM_PATH,
		process.env.ProgramFiles && join(process.env.ProgramFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
		process.env['ProgramFiles(x86)'] && join(process.env['ProgramFiles(x86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
		process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
		process.env['ProgramFiles(x86)'] && join(process.env['ProgramFiles(x86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe')
	];
	return candidates.find((candidate) => candidate && existsSync(candidate)) ?? null;
}

// ─── check ─────────────────────────────────────────────────────────────────

async function check(scope) {
	const rows = [];
	const add = (status, name, detail, hint) => rows.push({ status, name, detail, hint });

	// Tooling
	const nodeMinimum = parseVersion(pkg.engines?.node);
	const nodeVersion = parseVersion(process.versions.node);
	add(
		!nodeMinimum || atLeast(nodeVersion, nodeMinimum) ? 'OK' : 'FAIL',
		'Node.js',
		`${process.versions.node} (needs ${pkg.engines?.node ?? 'any'})`,
		'Install a newer Node 22: fnm install 22 && fnm default 22'
	);

	const pnpmWanted = parseVersion(pkg.packageManager?.split('@')[1]);
	const pnpm = run('pnpm', ['--version']);
	const pnpmVersion = parseVersion(pnpm.out);
	if (!pnpm.ok || !pnpmVersion) add('FAIL', 'pnpm', 'not found', 'Enable it with: corepack enable pnpm');
	else
		add(
			!pnpmWanted || (pnpmVersion[0] === pnpmWanted[0] && atLeast(pnpmVersion, pnpmWanted)) ? 'OK' : 'FAIL',
			'pnpm',
			`${pnpm.out} (repository uses ${pkg.packageManager})`,
			`Switch with: corepack prepare ${pkg.packageManager} --activate`
		);

	const docker = run('docker', ['--version']);
	if (!docker.ok) add('FAIL', 'Docker CLI', 'not found', 'Install Docker Desktop: winget install Docker.DockerDesktop');
	else {
		add('OK', 'Docker CLI', parseVersion(docker.out)?.join('.') ?? docker.out);
		const engine = run('docker', ['info', '--format', '{{.ServerVersion}}']);
		// Before the launcher's Docker step a stopped engine is expected, not a failure.
		add(engine.ok ? 'OK' : scope === 'tooling' ? 'WARN' : 'FAIL', 'Docker engine', engine.ok ? `${engine.out} running` : 'not running', 'Start Docker Desktop (run-all.bat starts it for you)');
	}

	const supabase = run('supabase', ['--version']);
	add(supabase.ok ? 'OK' : 'FAIL', 'Supabase CLI', supabase.ok ? supabase.out : 'not found', 'Install it: scoop install supabase (or npm i -g supabase)');

	if (scope !== 'tooling') {
		// Project
		const env = readEnvFile();
		if (!env) add('FAIL', '.env', 'missing', 'Run: pnpm setup:env (needs local Supabase running)');
		else {
			const missing = requiredEnv.filter((key) => !env[key]);
			add(missing.length ? 'FAIL' : 'OK', '.env required settings', missing.length ? `empty: ${missing.join(', ')}` : `${requiredEnv.length} set`, 'Regenerate with: pnpm setup:env --force (creates new local secrets)');

			let dbHost = null;
			try {
				dbHost = new URL(env.DATABASE_URL).hostname;
			} catch {
				// reported above when empty; an unparsable URL fails below
			}
			add(
				dbHost && localHosts.has(dbHost) ? 'OK' : 'FAIL',
				'.env database is local',
				dbHost ?? 'unparsable DATABASE_URL',
				'The launcher migrates and seeds: DATABASE_URL must point to the local Supabase (127.0.0.1)'
			);
			add(
				env.PAYMENTS_FAKE_PROVIDER === 'true' ? 'OK' : 'WARN',
				'Payment simulator',
				env.PAYMENTS_FAKE_PROVIDER === 'true' ? 'on' : 'off: checkout needs real sandbox credentials and a tunnel',
				'Set PAYMENTS_FAKE_PROVIDER=true in .env for local testing'
			);
			const newer = templateKeys().filter((key) => !(key in env));
			add(newer.length ? 'WARN' : 'OK', '.env vs env.template', newer.length ? `not in .env: ${newer.join(', ')}` : 'in sync', 'Copy the missing lines from env.template if you need them');
			const e2ePassword = process.env.E2E_ADMIN_PASSWORD ? 'set in the environment' : env.E2E_ADMIN_PASSWORD || env.SEED_ADMIN_PASSWORD ? 'set in .env' : null;
			add(
				e2ePassword ? 'OK' : 'WARN',
				'E2E admin password',
				e2ePassword ?? 'missing: E2E tests will be skipped',
				'Add SEED_ADMIN_PASSWORD=<password printed by pnpm db:seed> to .env'
			);
		}

		add(depsFresh() ? 'OK' : 'WARN', 'Dependencies', depsFresh() ? 'node_modules matches pnpm-lock.yaml' : 'missing or older than pnpm-lock.yaml', 'Run: pnpm install --frozen-lockfile');

		const running = supabaseRunning();
		add(running ? 'OK' : 'WARN', 'Local Supabase', running ? `supabase_db_${supabaseProjectId()} running` : 'not running', 'Run: pnpm db:start');
		if (running) {
			let dbPort = 54322;
			try {
				dbPort = Number(new URL(env?.DATABASE_URL ?? '').port || 5432);
			} catch {
				// keep the Supabase default
			}
			const open = await portOpen(dbPort);
			add(open ? 'OK' : 'FAIL', 'Local Postgres', open ? `accepting connections on ${dbPort}` : `nothing listening on ${dbPort}`, 'Restart it: pnpm db:stop && pnpm db:start');
		}

		const apiPort = Number(env?.API_PORT || 3001);
		for (const [name, port, health] of [
			['API port', apiPort, `http://127.0.0.1:${apiPort}/health`],
			['Web port', 5173, 'http://127.0.0.1:5173/']
		]) {
			if (!(await portOpen(port))) add('OK', name, `${port} free`);
			else if (await answers(health)) add('OK', name, `${port} in use by a running sortea stack`);
			else add('FAIL', name, `${port} in use by another process`, `Free port ${port}: netstat -ano | findstr :${port}`);
		}

		const browser = systemBrowser();
		add(
			browser ? 'OK' : 'WARN',
			'E2E browser',
			browser ?? 'no system Chrome or Edge found',
			'Install Playwright Chromium: pnpm --filter @sortea/web exec playwright install chromium'
		);
	}

	const width = Math.max(...rows.map((row) => row.name.length));
	for (const row of rows) {
		console.log(`  ${row.status.padEnd(4)}  ${row.name.padEnd(width)}  ${row.detail}`);
		if (row.status !== 'OK' && row.hint) console.log(`        ${' '.repeat(width)}  -> ${row.hint}`);
	}
	const failures = rows.filter((row) => row.status === 'FAIL').length;
	const warnings = rows.filter((row) => row.status === 'WARN').length;
	console.log(`\n  ${failures} failed, ${warnings} warnings, ${rows.length - failures - warnings} ok`);
	return failures === 0;
}

// ─── entry point ───────────────────────────────────────────────────────────

const [command = 'check', ...rest] = process.argv.slice(2);
const option = (name, fallback) => rest.find((arg) => arg.startsWith(`--${name}=`))?.split('=')[1] ?? fallback;

switch (command) {
	case 'check':
		process.exit((await check(option('scope', 'all'))) ? 0 : 1);
		break;
	case 'deps-fresh':
		process.exit(depsFresh() ? 0 : 1);
		break;
	case 'supabase-running':
		process.exit(supabaseRunning() ? 0 : 1);
		break;
	case 'wait': {
		const urls = rest.filter((arg) => !arg.startsWith('--'));
		const deadline = Date.now() + Number(option('timeout', '120')) * 1000;
		for (;;) {
			const ready = await Promise.all(urls.map((url) => answers(url)));
			if (ready.every(Boolean)) process.exit(0);
			if (Date.now() >= deadline) {
				console.error(`  not answering: ${urls.filter((_, index) => !ready[index]).join(', ')}`);
				process.exit(1);
			}
			await new Promise((resolve) => setTimeout(resolve, 2_000));
		}
	}
	case 'env': {
		const value = readEnvFile()?.[rest[0]];
		if (value) console.log(value);
		break;
	}
	case 'browser': {
		const browser = systemBrowser();
		if (browser) console.log(browser);
		break;
	}
	default:
		console.error(`Unknown command ${command}`);
		process.exit(2);
}
