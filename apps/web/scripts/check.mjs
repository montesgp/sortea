// Type-checks the web app. `svelte-kit sync` rewrites .svelte-kit/generated, and a
// running `vite dev` reloads the generated env module and loses the variables it
// read from .env at start (login and every page then fail). So sync runs only in CI
// or when the generated types are missing; a running dev server keeps them current.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const run = (command) => {
	const result = spawnSync(command, { stdio: 'inherit', shell: true });
	if (result.status !== 0) process.exit(result.status ?? 1);
};

if (process.env.CI || !existsSync('.svelte-kit/tsconfig.json')) run('svelte-kit sync');
run('svelte-check --tsconfig ./tsconfig.json');
