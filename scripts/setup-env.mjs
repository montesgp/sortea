// Writes a local .env from env.template plus generated secrets. The template's
// defaults are the local stack of docker-compose.yml (`pnpm db:start`).
// Usage: pnpm setup:env          create .env (refuses to overwrite an existing one)
//        pnpm setup:env --force  add what env.template has and .env lacks
//
// With --force, values already in .env are kept: secrets in particular, because
// the local database depends on them (sealed provider credentials need the same
// SECRETS_KEY_RING, pseudonyms the same pepper, seeded accounts the same
// password). Only missing values are generated or taken from the template. For
// brand-new secrets, delete .env and run `pnpm db:reset` afterwards.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildEnvFile, readEnv } from './env-file.mjs';

const target = new URL('../.env', import.meta.url);
const force = process.argv.includes('--force');
if (existsSync(target) && !force) {
	console.error('.env already exists; pass --force to add the settings it lacks (existing values are kept)');
	process.exit(1);
}

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
	generators
});
writeFileSync(target, result.text);
console.log(
	existing
		? `Refreshed .env: ${result.kept.length} existing values kept${result.generated.length ? `, generated ${result.generated.join(', ')}` : ''}`
		: 'Wrote .env with the local stack settings and new secrets'
);
