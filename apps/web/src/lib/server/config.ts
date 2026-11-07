import * as env from '$app/env/private';

type Required = 'API_INTERNAL_URL' | 'INTERNAL_API_TOKEN' | 'SUPABASE_URL' | 'SUPABASE_PUBLISHABLE_KEY';

/*
 * `svelte-kit sync` (run by type-checks, unit tests and the dev server itself
 * when files appear) regenerates the env module empty, and a running dev server
 * reloads it without reading .env again. The process environment still holds
 * the values, so it is the fallback; in production both agree.
 */

/** Reads a required server variable, failing with an actionable message instead of a vague network error. */
export function serverEnv(name: Required): string {
	const value = env[name] || process.env[name];
	if (!value) throw new Error(`${name} is not set. Run \`pnpm setup:env\` for local development or set it in the deployment.`);
	return value;
}

/** Whether the local payment simulator is on. */
export function paymentsSimulator(): boolean {
	return env.PAYMENTS_FAKE_PROVIDER || process.env.PAYMENTS_FAKE_PROVIDER === 'true';
}
