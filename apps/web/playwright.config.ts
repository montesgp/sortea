import { defineConfig } from '@playwright/test';

/**
 * End-to-end tests run against the local stack (`pnpm dev` with Supabase,
 * API, worker and web). They exercise the real webhook path through the
 * payment simulator and read emails from Mailpit.
 */
export default defineConfig({
	testDir: 'e2e',
	testMatch: '**/*.e2e.ts',
	timeout: 60_000,
	fullyParallel: false,
	retries: process.env.CI ? 1 : 0,
	use: {
		baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:5173',
		trace: 'retain-on-failure',
		launchOptions: process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {}
	}
});
