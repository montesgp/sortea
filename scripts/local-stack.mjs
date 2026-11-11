// Starts and stops the local stack of docker-compose.yml (ADR 0020, "Local development").
//
//   pnpm db:start   docker compose up --detach --wait <services>: Postgres, Mailpit and MinIO, healthy
//   pnpm db:stop    docker compose stop <services>: the data stays in the named volumes
//
// The services are named, never implied: the Supabase CLI labels its containers with the
// same compose project (`sortea`), and a bare compose command must not reach them.
// Start refuses while the Supabase CLI database runs, since it holds the same ports.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const STACK_SERVICES = ['postgres', 'mailpit', 'minio'];
const USAGE = 'Usage: node scripts/local-stack.mjs start|stop';

/** The docker command of an action. */
export function stackCommand(action) {
	if (action === 'start') return { command: 'docker', args: ['compose', 'up', '--detach', '--wait', ...STACK_SERVICES] };
	if (action === 'stop') return { command: 'docker', args: ['compose', 'stop', ...STACK_SERVICES] };
	throw new Error(USAGE);
}

/** Why an action must not run, given the names of the running containers; null when it may. */
export function stackRefusal(action, runningContainers) {
	if (action !== 'start') return null;
	const supabase = runningContainers.find((name) => name.startsWith('supabase_db_'));
	if (!supabase) return null;
	const project = supabase.slice('supabase_db_'.length);
	return [
		`${supabase} is running: the Supabase CLI stack holds ports 54322, 54324 and 54325.`,
		'Carry its database over first (README, "Moving off the Supabase CLI"):',
		'  pnpm db:import-from-supabase --dump-only',
		`  supabase stop --project-id ${project}`,
		'  pnpm db:start',
		'  pnpm db:import-from-supabase --restore <file it printed>'
	].join('\n');
}

function main() {
	const action = process.argv[2];
	const { command, args } = stackCommand(action);
	const root = fileURLToPath(new URL('..', import.meta.url));
	const listed = spawnSync('docker', ['ps', '--format', '{{.Names}}'], { encoding: 'utf8', windowsHide: true });
	if (listed.status !== 0) throw new Error('Docker is not answering: start Docker Desktop first.');
	const refusal = stackRefusal(action, listed.stdout.split(/\r?\n/).filter(Boolean));
	if (refusal) throw new Error(refusal);
	const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', windowsHide: true });
	process.exitCode = result.status ?? 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	try {
		main();
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	}
}
