import { defineEnvVars } from '@sveltejs/kit/env';
import { building } from '$app/env';

const required = (name: string) => (value: string | undefined) => {
	if (building) return value ?? '';
	if (!value) throw new Error(`${name} is not set. Run \`pnpm setup:env\` for local development.`);
	return value;
};

export const variables = defineEnvVars({
	API_INTERNAL_URL: {
		description: 'Private URL of the Fastify API (Railway internal network in production)',
		schema: required('API_INTERNAL_URL')
	},
	INTERNAL_API_TOKEN: {
		description: 'Shared secret the web tier presents to the API',
		schema: required('INTERNAL_API_TOKEN')
	},
	SUPABASE_URL: {
		description: 'Supabase project URL, used server-side for admin sign-in',
		schema: required('SUPABASE_URL')
	},
	SUPABASE_PUBLISHABLE_KEY: {
		description: 'Supabase publishable key, used server-side only for admin sign-in',
		schema: required('SUPABASE_PUBLISHABLE_KEY')
	},
	PAYMENTS_FAKE_PROVIDER: {
		description: 'Shows the local payment simulator page',
		schema: (value) => value === 'true'
	}
});
