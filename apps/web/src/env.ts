import { defineEnvVars } from '@sveltejs/kit/env';

/**
 * Values are validated where they are used (see #lib/server/config), not
 * here: `svelte-kit sync` regenerates the env module with an empty
 * environment, and a throwing schema would break a running dev server.
 */
const text = (value: string | undefined) => value ?? '';

export const variables = defineEnvVars({
	API_INTERNAL_URL: { description: 'Private URL of the Fastify API (Railway internal network in production)', schema: text },
	INTERNAL_API_TOKEN: { description: 'Shared secret the web tier presents to the API', schema: text },
	SUPABASE_URL: { description: 'Supabase project URL, used server-side for admin sign-in', schema: text },
	SUPABASE_PUBLISHABLE_KEY: { description: 'Supabase publishable key, used server-side only for admin sign-in', schema: text },
	PAYMENTS_FAKE_PROVIDER: { description: 'Shows the local payment simulator page', schema: (value) => value === 'true' }
});
