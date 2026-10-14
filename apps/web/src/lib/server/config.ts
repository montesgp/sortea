import * as env from '$app/env/private';

type Required = 'API_INTERNAL_URL' | 'INTERNAL_API_TOKEN' | 'SUPABASE_URL' | 'SUPABASE_PUBLISHABLE_KEY';

/** Reads a required server variable, failing with an actionable message instead of a vague network error. */
export function serverEnv(name: Required): string {
	const value = env[name];
	if (!value) throw new Error(`${name} is not set. Run \`pnpm setup:env\` for local development or set it in the deployment.`);
	return value;
}
