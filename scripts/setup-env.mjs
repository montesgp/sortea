// Writes a local .env from `supabase status` plus freshly generated secrets.
// Usage: pnpm setup:env  (refuses to overwrite an existing .env unless --force)
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const target = new URL('../.env', import.meta.url);
if (existsSync(target) && !process.argv.includes('--force')) {
	console.error('.env already exists; pass --force to regenerate it');
	process.exit(1);
}

const status = spawnSync('supabase', ['status', '-o', 'env'], {
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

const secret = (bytes = 32) => randomBytes(bytes).toString('base64url');
const template = readFileSync(new URL('../env.template', import.meta.url), 'utf8');
const values = {
	DATABASE_URL: supabase.DB_URL,
	SUPABASE_URL: supabase.API_URL,
	SUPABASE_PUBLISHABLE_KEY: supabase.PUBLISHABLE_KEY ?? supabase.ANON_KEY,
	SUPABASE_SECRET_KEY: supabase.SECRET_KEY ?? supabase.SERVICE_ROLE_KEY,
	SECRETS_KEY_RING: `v1:${randomBytes(32).toString('base64')}`,
	LOOKUP_PEPPER: secret(),
	PSEUDONYM_PEPPER: secret(),
	INTERNAL_API_TOKEN: secret(),
	DEV_WEBHOOK_SECRET: secret()
};

const output = template.replace(/^([A-Z_]+)=.*$/gm, (line, key) => (key in values ? `${key}=${values[key]}` : line));
writeFileSync(target, output);
console.log('Wrote .env with local Supabase settings and new secrets');
