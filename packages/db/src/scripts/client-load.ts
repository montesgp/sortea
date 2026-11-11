import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseKeyRing } from '@sortea/domain/server';
import { createDatabase } from '../client';
import { declaredFileReader, removeIncomingFiles } from '../client-files';
import { ClientPackRefusedError, loadClientPack, type ClientPack, type ClientPackServices } from '../client-pack';
import { ProductFileRefusedError } from '../product-file';
import { clientFilesDir, clientPackPath, parseClientLoadArgs } from './client-load-args';
import { createObjectStore, isLocalEndpoint, objectStoreConfigFromEnv, ObjectStoreConfigError, PRODUCT_ASSETS_PREFIX, scopedStore } from '../object-store';
import { ensureAdminUser } from '../admin-users';
import { databaseUrl, isLocalDatabase } from './env';

/**
 * Loads a private client pack (`clients/<client>/pack.ts`) into the database
 * at DATABASE_URL, with its users in admin_users and the bucket of the S3
 * variables (clients/README.md in the private repository).
 *
 *   pnpm client:load <client> [--update [--catalog] [--campaign]] [--host <hostname>]
 *
 * It creates the organization when it is missing. With `--update` it refreshes
 * the name, settings, theme and site blocks of an existing one with the same
 * slug, and with `--catalog` too its products and their files (created or
 * updated by slug, never deleted), and with `--campaign` the pack's campaign as a
 * draft when it has none with that slug; without `--update`, an existing organization is left
 * as it is. It never touches other organizations and never grants an approval.
 * The pack's local accounts are created only on a local database, and users
 * that already exist keep their password; a deployed environment gets its
 * people from the console.
 *
 * Digital products get the real files the pack declares, from
 * `clients/<client>/files` or, inside a deployed api service, from the
 * bucket's `product-assets/_incoming/` where `pnpm client:upload-files` put
 * them (packages/db/src/client-files.ts). Only a local database may get the
 * sample PDF instead.
 */
const repositoryRoot = resolve(import.meta.dirname, '../../../..');

const url = databaseUrl();
const handle = createDatabase(url, { max: 1 });
try {
	const args = parseClientLoadArgs(process.argv.slice(2));
	// A build ships the packs compiled next to this command (`dist/packs/<client>.js`); sources read `clients/<client>/pack.ts`.
	const compiled = join(import.meta.dirname, 'packs', `${args.client}.js`);
	const packFile = existsSync(compiled) ? compiled : clientPackPath(repositoryRoot, args.client);
	const { pack } = (await import(pathToFileURL(packFile).href)) as { pack: ClientPack };
	if (pack.slug !== args.client) throw new ClientPackRefusedError(`clients/${args.client}/pack.ts has the slug ${pack.slug}; the directory and the slug must match.`);

	const storeConfig = objectStoreConfigFromEnv();
	const bucket = createObjectStore(storeConfig);
	const productFiles = scopedStore(bucket, PRODUCT_ASSETS_PREFIX);
	const password = process.env.SEED_ADMIN_PASSWORD ?? `dev-${randomBytes(9).toString('base64url')}`;
	// Local accounts and the payment simulator only on a local database; deployed environments set both up in the platform console.
	const local = isLocalDatabase(url);
	// Only the local MinIO bucket is created here; a deployed bucket is created by its platform.
	if (local && isLocalEndpoint(storeConfig.endpoint)) await bucket.ensureBucket();
	const simulator = local && process.env.SECRETS_KEY_RING && process.env.DEV_WEBHOOK_SECRET;
	const services: ClientPackServices = {
		// Called only for the pack's members, which are passed on a local database only (below).
		ensureUser: (email, tx) => ensureAdminUser(tx, email, password, { resetPassword: false }),
		uploadProductFile: (path, bytes, contentType) => productFiles.put(path, bytes, { contentType }),
		readDeclaredFile: declaredFileReader({ dir: clientFilesDir(repositoryRoot, args.client), label: `clients/${args.client}/files`, incoming: productFiles }),
		productFileStorage: {
			upload: (path, bytes, contentType) => productFiles.put(path, bytes, { contentType }),
			exists: (path) => productFiles.exists(path),
			remove: (paths) => productFiles.remove(paths)
		},
		...(simulator ? { paymentSimulator: { ring: parseKeyRing(process.env.SECRETS_KEY_RING!), webhookSecret: process.env.DEV_WEBHOOK_SECRET! } } : {})
	};

	console.log(`Database: ${new URL(url).host}${new URL(url).pathname}  Storage: ${bucket.location}/${PRODUCT_ASSETS_PREFIX}`);
	const result = await loadClientPack(handle, { ...pack, hosts: args.host ? [args.host] : pack.hosts, members: local ? pack.members : [] }, services, {
		update: args.update,
		catalog: args.catalog,
		campaign: args.campaign,
		realFilesOnly: !local,
		productFileOptions: {
			sleep: (ms) => {
				console.log(`A product now points to its new file. The previous one is deleted in ${ms / 1000} s, once download links already signed for it expire.`);
				return new Promise((resolve) => setTimeout(resolve, ms));
			}
		}
	});
	const host = result.primaryHost ?? 'no host';
	if (result.outcome === 'created') {
		console.log(`Created ${pack.name} (${pack.slug}) on ${host}; hosts: ${result.hosts.join(', ')}`);
		console.log(simulator ? '  Payments: local simulator.' : '  Payments: none yet; connect Mercado Pago in the platform console.');
		if (!local) console.log('  Accounts: none on a deployed database; create them in the platform console or with pnpm admin:user.');
		else if (result.createdUsers.length > 0) console.log(`  New local accounts (password ${password}): ${result.createdUsers.join(', ')}`);
	} else if (result.outcome === 'exists') {
		console.log(`${pack.name} (${pack.slug}) already exists on ${host}; nothing changed. Pass --update to refresh its content.`);
	} else {
		console.log(`Updated ${pack.name} (${pack.slug}) on ${host}: ${result.changes.length > 0 ? result.changes.join(', ') : 'nothing to change'}.`);
		console.log(args.catalog ? '  Products are never deleted; members and hosts are never changed by an update.' : '  The catalog, members and hosts are never changed by an update; pass --catalog for the products.');
		console.log(args.campaign ? '  An existing campaign is never changed; a new one is a draft: review it, record its approvals and open it in the admin.' : '  Campaigns are never changed by an update; pass --campaign to add the pack campaign when it is missing.');
	}
	for (const file of result.files ?? []) {
		console.log(file.source === 'sample' ? `  ${file.productSlug}: the sample PDF; its real file is not on this machine (pnpm client:export ${pack.slug}).` : `  ${file.productSlug}: ${file.filename} from ${file.location}`);
	}
	const moved = await removeIncomingFiles(productFiles, pack, result);
	if (moved.length > 0) console.log(`  Removed ${moved.map((path) => `${PRODUCT_ASSETS_PREFIX}${path}`).join(', ')}: the files now live under their products.`);
} catch (error) {
	console.error(error instanceof ClientPackRefusedError || error instanceof ProductFileRefusedError || error instanceof ObjectStoreConfigError ? error.message : error);
	process.exitCode = 1;
} finally {
	await handle.close();
}
