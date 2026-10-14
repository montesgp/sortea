import { z } from 'zod';

const boolean = z
	.enum(['true', 'false'])
	.default('false')
	.transform((value) => value === 'true');

const schema = z.object({
	NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
	API_PORT: z.coerce.number().int().default(3001),
	API_PUBLIC_URL: z.url(),
	WEB_FALLBACK_ORIGIN: z.url(),
	DATABASE_URL: z.string().min(1),
	SUPABASE_URL: z.url(),
	SUPABASE_SECRET_KEY: z.string().min(1),
	STORAGE_BUCKET: z.string().default('product-assets'),
	SECRETS_KEY_RING: z.string().min(1),
	LOOKUP_PEPPER: z.string().min(16),
	PSEUDONYM_PEPPER: z.string().min(16),
	INTERNAL_API_TOKEN: z.string().min(16),
	PAYMENTS_FAKE_PROVIDER: boolean,
	REQUIRE_ADMIN_MFA: boolean
});

export type ApiConfig = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
	const parsed = schema.safeParse(env);
	if (!parsed.success) {
		const fields = parsed.error.issues.map((issue) => issue.path.join('.')).join(', ');
		throw new Error(`Invalid API configuration: ${fields}. Run \`pnpm setup:env\` for local development.`);
	}
	const config = parsed.data;
	if (config.NODE_ENV === 'production') {
		if (config.PAYMENTS_FAKE_PROVIDER) throw new Error('The payment simulator cannot run in production');
		if (!config.REQUIRE_ADMIN_MFA) throw new Error('Admin MFA is mandatory in production');
	}
	return config;
}
