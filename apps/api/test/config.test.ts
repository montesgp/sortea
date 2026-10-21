import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';

const base = {
	NODE_ENV: 'development',
	API_PUBLIC_URL: 'http://localhost:3001',
	WEB_FALLBACK_ORIGIN: 'http://localhost:5173',
	DATABASE_URL: 'postgresql://localhost/test',
	SUPABASE_URL: 'http://localhost:54321',
	SUPABASE_SECRET_KEY: 'secret',
	SECRETS_KEY_RING: 'v1:key',
	LOOKUP_PEPPER: 'lookup-pepper-0123456789',
	PSEUDONYM_PEPPER: 'pseudonym-pepper-0123456789',
	INTERNAL_API_TOKEN: 'internal-token-0123456789',
	PAYMENTS_FAKE_PROVIDER: 'true'
};

describe('compliance demo mode configuration (S1)', () => {
	it('is off unless asked for', () => {
		expect(loadConfig(base).COMPLIANCE_DEMO).toBe(false);
	});

	it('runs locally with the payment simulator', () => {
		expect(loadConfig({ ...base, COMPLIANCE_DEMO: 'true' }).COMPLIANCE_DEMO).toBe(true);
	});

	it('is refused without the payment simulator, so no real payment can earn chances under it', () => {
		expect(() => loadConfig({ ...base, COMPLIANCE_DEMO: 'true', PAYMENTS_FAKE_PROVIDER: 'false' })).toThrow(
			'The compliance demo mode needs the payment simulator'
		);
	});

	it('is refused in production', () => {
		expect(() =>
			loadConfig({ ...base, NODE_ENV: 'production', COMPLIANCE_DEMO: 'true', PAYMENTS_FAKE_PROVIDER: 'false', REQUIRE_ADMIN_MFA: 'true' })
		).toThrow('The compliance demo mode cannot run in production');
	});

	it('production without it still loads', () => {
		expect(loadConfig({ ...base, NODE_ENV: 'production', PAYMENTS_FAKE_PROVIDER: 'false', REQUIRE_ADMIN_MFA: 'true' }).COMPLIANCE_DEMO).toBe(false);
	});
});
