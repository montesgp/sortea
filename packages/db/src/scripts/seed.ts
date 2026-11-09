import { randomBytes } from 'node:crypto';
import { parseKeyRing } from '@sortea/domain/server';
import { loadClientPack, type ClientPack, type ClientPackResult, type ClientPackServices } from '../client-pack';
import { createDatabase } from '../client';
import { pistaSurPack } from '../packs/pista-sur';
import { tallerDemoPack } from '../packs/taller-demo';
import * as s from '../schema';
import { assertLocalDatabase, databaseUrl } from './env';
import { supabaseAdmin } from './supabase-admin';

/**
 * Local development data: the fictional "Taller Demo" with a clearly labelled
 * demo campaign, and "Pista Sur", a fictional second tenant used to prove
 * theming and isolation (AC-02, AC-10). Real clients' content lives in the
 * private client packs and is loaded with `pnpm client:load <client>`.
 *
 * The seed is additive: it creates each of the two organizations only when it
 * is missing and never changes any other organization's rows. On a database
 * where another organization already has `localhost`, Taller Demo gets
 * `demo.localhost` (packages/db/src/packs/taller-demo.ts).
 *
 * No legal or PSP approval is seeded: the demo campaign stays `published` and
 * cannot open until someone records real approvals in the admin.
 */
const url = databaseUrl();
assertLocalDatabase(url);
const env = requireEnv(['SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'SECRETS_KEY_RING', 'DEV_WEBHOOK_SECRET']);
const bucket = process.env.STORAGE_BUCKET ?? 'product-assets';
const mediaBucket = process.env.MEDIA_BUCKET ?? 'site-media';
const handle = createDatabase(url, { max: 2 });
const supabase = supabaseAdmin(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY);
const platformAdminEmail = 'admin@sortea.local';

/**
 * Private bucket for product files. Illustrated manuals pass 50 MB (the first
 * client's is 61 MB), so it takes up to 100 MB, as does supabase/config.toml.
 */
const bucketOptions = { public: false, fileSizeLimit: 100 * 1024 * 1024, allowedMimeTypes: ['application/pdf', 'application/zip'] };

/**
 * Public bucket for site images and videos (FR-CMS-04, S9); product files stay in
 * the private bucket. The API enforces the per-kind limits (images 2 MB, videos
 * 50 MB); the bucket only refuses anything else.
 */
const mediaBucketOptions = { public: true, fileSizeLimit: 50 * 1024 * 1024, allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/webm'] };

async function main(): Promise<void> {
	// Buckets are created or updated even on a seeded database, so new ones appear without a reset.
	await supabase.ensureBucket(bucket, bucketOptions);
	await supabase.ensureBucket(mediaBucket, mediaBucketOptions);
	const password = process.env.SEED_ADMIN_PASSWORD ?? `dev-${randomBytes(6).toString('base64url')}`;
	const services: ClientPackServices = {
		ensureUser: (email) => supabase.ensureUser(email, password, { resetPassword: true }),
		uploadProductFile: (path, bytes, contentType) => supabase.upload(bucket, path, bytes, contentType),
		paymentSimulator: { ring: parseKeyRing(env.SECRETS_KEY_RING), webhookSecret: env.DEV_WEBHOOK_SECRET }
	};

	const admins = await handle.withPlatform((db) => db.select({ userId: s.platformAdmins.userId }).from(s.platformAdmins).limit(1));
	if (admins.length === 0) {
		const admin = await services.ensureUser(platformAdminEmail);
		await handle.withPlatform((db) => db.insert(s.platformAdmins).values({ userId: admin.id, email: platformAdminEmail }));
	}

	const loaded: [ClientPack, ClientPackResult][] = [];
	for (const pack of [tallerDemoPack, pistaSurPack]) loaded.push([pack, await loadClientPack(handle, pack, services)]);

	const created = loaded.filter(([, result]) => result.outcome === 'created');
	if (admins.length > 0 && created.length === 0) {
		console.log('Seed data already present. Run `pnpm db:reset` for a clean database.');
		return;
	}
	console.log('\nSeed complete. Local admin accounts (password for all):', password);
	if (admins.length === 0) console.log(`  ${platformAdminEmail.padEnd(28)}platform_superadmin`);
	for (const [pack] of created) {
		for (const member of pack.members) console.log(`  ${member.email.padEnd(28)}${member.role} (${pack.name})`);
	}
	for (const [pack, result] of loaded) {
		const site = result.primaryHost ? `http://${result.primaryHost}:5173` : 'no host';
		console.log(`${result.outcome === 'created' ? 'Created' : 'Already present:'} ${pack.name} at ${site}`);
	}
}

function requireEnv<K extends string>(keys: K[]): Record<K, string> {
	const missing = keys.filter((key) => !process.env[key]);
	if (missing.length) throw new Error(`Missing environment variables: ${missing.join(', ')}. Run \`pnpm setup:env\`.`);
	return Object.fromEntries(keys.map((key) => [key, process.env[key]!])) as Record<K, string>;
}

try {
	await main();
} finally {
	await handle.close();
}
