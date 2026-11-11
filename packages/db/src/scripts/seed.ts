import { randomBytes } from 'node:crypto';
import { parseKeyRing } from '@sortea/domain/server';
import { loadClientPack, type ClientPack, type ClientPackResult, type ClientPackServices } from '../client-pack';
import { createDatabase } from '../client';
import { createObjectStore, isLocalEndpoint, objectStoreConfigFromEnv, PRODUCT_ASSETS_PREFIX, scopedStore } from '../object-store';
import { pistaSurPack } from '../packs/pista-sur';
import { tallerDemoPack } from '../packs/taller-demo';
import * as s from '../schema';
import { ensureAdminUser } from '../admin-users';
import { assertLocalDatabase, databaseUrl } from './env';

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
const env = requireEnv(['SECRETS_KEY_RING', 'DEV_WEBHOOK_SECRET']);
const storeConfig = objectStoreConfigFromEnv();
const handle = createDatabase(url, { max: 2 });
const bucket = createObjectStore(storeConfig);
const productFiles = scopedStore(bucket, PRODUCT_ASSETS_PREFIX);
const platformAdminEmail = 'admin@sortea.local';

/*
 * One private S3 bucket holds product files and site media under their prefixes
 * (ADR 0020). It has no per-type limits: `pnpm db:product-file` accepts only PDF
 * and ZIP, and the API enforces the media limits (images 2 MB, videos 50 MB).
 */

async function main(): Promise<void> {
	// The local MinIO bucket is created even on a seeded database; a deployed bucket is created by its platform.
	if (isLocalEndpoint(storeConfig.endpoint)) await bucket.ensureBucket();
	const password = process.env.SEED_ADMIN_PASSWORD ?? `dev-${randomBytes(6).toString('base64url')}`;
	const services: ClientPackServices = {
		// Local accounts in admin_users (ADR 0020); the seed refuses any non-local database above.
		ensureUser: (email, tx) => ensureAdminUser(tx, email, password, { resetPassword: true }),
		uploadProductFile: (path, bytes, contentType) => productFiles.put(path, bytes, { contentType }),
		paymentSimulator: { ring: parseKeyRing(env.SECRETS_KEY_RING), webhookSecret: env.DEV_WEBHOOK_SECRET }
	};

	const admins = await handle.withPlatform((db) => db.select({ userId: s.platformAdmins.userId }).from(s.platformAdmins).limit(1));
	if (admins.length === 0) {
		await handle.withPlatform((db) =>
			db.transaction(async (tx) => {
				const admin = await services.ensureUser(platformAdminEmail, tx);
				await tx.insert(s.platformAdmins).values({ userId: admin.id, email: platformAdminEmail });
			})
		);
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
