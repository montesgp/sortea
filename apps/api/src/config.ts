import { z } from 'zod';

const boolean = z
	.enum(['true', 'false'])
	.default('false')
	.transform((value) => value === 'true');

const schema = z.object({
	NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
	/** Falls back to PORT, which hosts such as Railway inject (README, "Deploy"). */
	API_PORT: z.coerce.number().int().default(3001),
	/** One address to listen on; by default `::` with a fallback to `0.0.0.0` (src/listen.ts). */
	API_HOST: z.preprocess((value) => (value === '' ? undefined : value), z.string().optional()),
	API_PUBLIC_URL: z.url(),
	WEB_FALLBACK_ORIGIN: z.url(),
	DATABASE_URL: z.string().min(1),
	/**
	 * The environment's S3-compatible bucket (ADR 0020, "Files"), one variable per credential
	 * of a Railway Bucket. No endpoint means AWS S3 itself.
	 */
	S3_ENDPOINT: z.preprocess((value) => (value === '' ? undefined : value), z.url().optional()),
	S3_REGION: z.string().min(1),
	S3_BUCKET: z.string().min(1),
	S3_ACCESS_KEY_ID: z.string().min(1),
	S3_SECRET_ACCESS_KEY: z.string().min(1),
	S3_FORCE_PATH_STYLE: boolean,
	SECRETS_KEY_RING: z.string().min(1),
	LOOKUP_PEPPER: z.string().min(16),
	PSEUDONYM_PEPPER: z.string().min(16),
	INTERNAL_API_TOKEN: z.string().min(16),
	PAYMENTS_FAKE_PROVIDER: boolean,
	/**
	 * Rehearsal of demo campaigns with pending approvals outside production (ADR 0013). The waiver
	 * applies only while the organization's active account is the simulator or a Mercado Pago test user.
	 */
	COMPLIANCE_DEMO: boolean,
	REQUIRE_ADMIN_MFA: boolean,
	/**
	 * The drand relays an in-app tirada reads its round from, comma-separated, in order (ADR 0026);
	 * empty means https://api.drand.sh, api2, api3 and https://drand.cloudflare.com.
	 */
	DRAND_RELAYS: z.string().optional()
});

export type ApiConfig = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
	const parsed = schema.safeParse({ ...env, API_PORT: env.API_PORT || env.PORT || undefined });
	if (!parsed.success) {
		const fields = parsed.error.issues.map((issue) => issue.path.join('.')).join(', ');
		throw new Error(`Invalid API configuration: ${fields}. Run \`pnpm setup:env\` for local development.`);
	}
	const config = parsed.data;
	if (config.NODE_ENV === 'production') {
		if (config.COMPLIANCE_DEMO) throw new Error('The compliance demo mode cannot run in production');
		if (config.PAYMENTS_FAKE_PROVIDER) throw new Error('The payment simulator cannot run in production');
		if (!config.REQUIRE_ADMIN_MFA) throw new Error('Admin MFA is mandatory in production');
	}
	return config;
}
