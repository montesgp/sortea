import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';

const base = {
	NODE_ENV: 'development',
	API_PUBLIC_URL: 'http://localhost:3001',
	WEB_FALLBACK_ORIGIN: 'http://localhost:5173',
	DATABASE_URL: 'postgresql://localhost/test',
	S3_ENDPOINT: 'http://127.0.0.1:9000',
	S3_REGION: 'us-east-1',
	S3_BUCKET: 'sortea-local',
	S3_ACCESS_KEY_ID: 'access-key',
	S3_SECRET_ACCESS_KEY: 'secret-key',
	S3_FORCE_PATH_STYLE: 'true',
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

	it('runs outside production with real Mercado Pago too: only test accounts get the waiver (2026-11-07)', () => {
		expect(loadConfig({ ...base, COMPLIANCE_DEMO: 'true', PAYMENTS_FAKE_PROVIDER: 'false' }).COMPLIANCE_DEMO).toBe(true);
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

describe('object storage configuration (ADR 0020, Files)', () => {
	it('reads the bucket from the S3 variables, without any Supabase storage key', () => {
		expect(loadConfig(base)).toMatchObject({
			S3_ENDPOINT: 'http://127.0.0.1:9000',
			S3_REGION: 'us-east-1',
			S3_BUCKET: 'sortea-local',
			S3_ACCESS_KEY_ID: 'access-key',
			S3_SECRET_ACCESS_KEY: 'secret-key',
			S3_FORCE_PATH_STYLE: true
		});
		expect(loadConfig(base)).not.toHaveProperty('SUPABASE_SECRET_KEY');
		expect(loadConfig(base)).not.toHaveProperty('STORAGE_BUCKET');
		expect(loadConfig(base)).not.toHaveProperty('MEDIA_BUCKET');
	});

	it('the endpoint is optional (AWS itself) and virtual-hosted style is the default', () => {
		const { S3_ENDPOINT: _endpoint, S3_FORCE_PATH_STYLE: _style, ...aws } = base;
		const config = loadConfig(aws);
		expect(config.S3_ENDPOINT).toBeUndefined();
		expect(config.S3_FORCE_PATH_STYLE).toBe(false);
		expect(loadConfig({ ...aws, S3_ENDPOINT: '' }).S3_ENDPOINT).toBeUndefined();
	});

	it('refuses to start without the bucket or its credentials, naming the variables only', () => {
		for (const key of ['S3_REGION', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'] as const) {
			const { [key]: _missing, ...rest } = base;
			expect(() => loadConfig(rest), key).toThrow(key);
		}
		expect(() => loadConfig({ ...base, S3_ENDPOINT: 'not a url' })).toThrow('S3_ENDPOINT');
	});
});

describe('admin sign-in configuration (ADR 0020)', () => {
	it('needs no Supabase variable: the API signs admins in itself', () => {
		const config = loadConfig({ ...base, SUPABASE_URL: 'http://localhost:54321' });
		expect(config).not.toHaveProperty('SUPABASE_URL');
		expect(config).not.toHaveProperty('SUPABASE_PUBLISHABLE_KEY');
	});

	it('still refuses production without admin MFA', () => {
		expect(() => loadConfig({ ...base, NODE_ENV: 'production', PAYMENTS_FAKE_PROVIDER: 'false', REQUIRE_ADMIN_MFA: 'false' })).toThrow('Admin MFA is mandatory in production');
	});
});

describe('port (ADR 0020, deploy)', () => {
	it('is API_PORT, else the PORT the platform injects, else 3001', () => {
		expect(loadConfig(base).API_PORT).toBe(3001);
		expect(loadConfig({ ...base, PORT: '8080' }).API_PORT).toBe(8080);
		expect(loadConfig({ ...base, PORT: '8080', API_PORT: '3002' }).API_PORT).toBe(3002);
	});
});
