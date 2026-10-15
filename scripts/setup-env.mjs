// Writes a local .env from `supabase status` plus generated secrets.
// Usage: pnpm setup:env          create .env (refuses to overwrite an existing one)
//        pnpm setup:env --force  refresh the Supabase settings of an existing .env
//
// With --force, values already in .env are kept: secrets in particular, because
// the local database depends on them (sealed provider credentials need the same
// SECRETS_KEY_RING, pseudonyms the same pepper, seeded accounts the same
// password). Only missing values are generated. For brand-new secrets, delete
// .env and run `pnpm db:reset` afterwards.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildEnvFile, readEnv } from './env-file.mjs';

const target = new URL('../.env', import.meta.url);
const force = process.argv.includes('--force');
if (existsSync(target) && !force) {
	console.error('.env already exists; pass --force to refresh its Supabase settings (existing secrets are kept)');
	process.exit(1);
}

const status = spawnSync('supabase', ['status', '-o', 'env'], {
	// The CLI finds the project through supabase/config.toml in its working directory.
	cwd: fileURLToPath(new URL('..', import.meta.url)),
	encoding: 'utf8',
	shell: process.platform === 'win32',
	env: { ...process.env, SUPABASE_PROFILE: process.env.SUPABASE_PROFILE ?? 'supabase' }
});
if (status.status !== 0) {
	console.error('Could not read `supabase status`. Run `pnpm db:start` first.\n' + status.stderr);
	process.exit(1);
}
const supabase = Object.fromEntries(
	status.stdout
		.split(/\r?\n/)
		.map((line) => /^([A-Z_]+)="?(.*?)"?$/.exec(line))
		.filter(Boolean)
		.map((match) => [match[1], match[2]])
);

/** Always taken from the running local Supabase. */
const fromSupabase = {
	DATABASE_URL: supabase.DB_URL,
	SUPABASE_URL: supabase.API_URL,
	SUPABASE_PUBLISHABLE_KEY: supabase.PUBLISHABLE_KEY ?? supabase.ANON_KEY,
	SUPABASE_SECRET_KEY: supabase.SECRET_KEY ?? supabase.SERVICE_ROLE_KEY
};

const secret = (bytes = 32) => randomBytes(bytes).toString('base64url');
/** Generated only when .env does not have them yet. */
const generators = {
	SECRETS_KEY_RING: () => `v1:${randomBytes(32).toString('base64')}`,
	LOOKUP_PEPPER: () => secret(),
	PSEUDONYM_PEPPER: () => secret(),
	INTERNAL_API_TOKEN: () => secret(),
	DEV_WEBHOOK_SECRET: () => secret(),
	SEED_ADMIN_PASSWORD: () => `dev-${secret(9)}`
};

// Values already in .env are kept exactly as written, quotes included (see buildEnvFile).
const existing = readEnv(fileURLToPath(target));
const result = buildEnvFile({
	template: readFileSync(new URL('../env.template', import.meta.url), 'utf8'),
	existing,
	fromSupabase,
	generators
});
writeFileSync(target, result.text);
console.log(
	existing
		? `Refreshed .env: Supabase settings updated, ${result.kept.length} existing values kept${result.generated.length ? `, generated ${result.generated.join(', ')}` : ''}`
		: 'Wrote .env with local Supabase settings and new secrets'
);
