import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseKeyRing } from '@sortea/domain/server';
import { createDatabase } from '../client';
import { ClientPackRefusedError, loadClientPack, type ClientPack, type ClientPackServices } from '../client-pack';
import { clientPackPath, parseClientLoadArgs } from './client-load-args';
import { databaseUrl, isLocalDatabase } from './env';
import { supabaseAdmin } from './supabase-admin';

/**
 * Loads a private client pack (`clients/<client>/pack.ts`) into the database
 * at DATABASE_URL, with the users and storage of SUPABASE_URL
 * (clients/README.md in the private repository).
 *
 *   pnpm client:load <client> [--update] [--host <hostname>]
 *
 * It creates the organization when it is missing. With `--update` it refreshes
 * the name, settings, theme and site blocks of an existing one with the same
 * slug; without it, an existing organization is left as it is. It never touches
 * other organizations and never grants an approval. The pack's local accounts
 * are created only on a local database, and users that already exist keep
 * their password; a deployed environment gets its people from the console.
 */
const repositoryRoot = resolve(import.meta.dirname, '../../../..');

const url = databaseUrl();
const handle = createDatabase(url, { max: 1 });
try {
	const args = parseClientLoadArgs(process.argv.slice(2));
	const { pack } = (await import(pathToFileURL(clientPackPath(repositoryRoot, args.client)).href)) as { pack: ClientPack };
	if (pack.slug !== args.client) throw new ClientPackRefusedError(`clients/${args.client}/pack.ts has the slug ${pack.slug}; the directory and the slug must match.`);

	const supabaseUrl = process.env.SUPABASE_URL;
	const secretKey = process.env.SUPABASE_SECRET_KEY;
	if (!supabaseUrl || !secretKey) throw new ClientPackRefusedError('Set SUPABASE_URL and SUPABASE_SECRET_KEY for the environment that receives the client.');
	const supabase = supabaseAdmin(supabaseUrl, secretKey);
	const bucket = process.env.STORAGE_BUCKET ?? 'product-assets';
	const password = process.env.SEED_ADMIN_PASSWORD ?? `dev-${randomBytes(9).toString('base64url')}`;
	// Local accounts and the payment simulator only on a local database; deployed environments set both up in the platform console.
	const local = isLocalDatabase(url);
	const simulator = local && process.env.SECRETS_KEY_RING && process.env.DEV_WEBHOOK_SECRET;
	const services: ClientPackServices = {
		ensureUser: (email) => supabase.ensureUser(email, password, { resetPassword: false }),
		uploadProductFile: (path, bytes, contentType) => supabase.upload(bucket, path, bytes, contentType),
		...(simulator ? { paymentSimulator: { ring: parseKeyRing(process.env.SECRETS_KEY_RING!), webhookSecret: process.env.DEV_WEBHOOK_SECRET! } } : {})
	};

	console.log(`Database: ${new URL(url).host}${new URL(url).pathname}  Users and storage: ${supabase.host}/${bucket}`);
	const result = await loadClientPack(handle, { ...pack, hosts: args.host ? [args.host] : pack.hosts, members: local ? pack.members : [] }, services, { update: args.update });
	const host = result.primaryHost ?? 'no host';
	if (result.outcome === 'created') {
		console.log(`Created ${pack.name} (${pack.slug}) on ${host}; hosts: ${result.hosts.join(', ')}`);
		console.log(simulator ? '  Payments: local simulator.' : '  Payments: none yet; connect Mercado Pago in the platform console.');
		if (!local) console.log('  Accounts: none on a deployed database; invite people from the platform console.');
		else if (result.createdUsers.length > 0) console.log(`  New local accounts (password ${password}): ${result.createdUsers.join(', ')}`);
	} else if (result.outcome === 'exists') {
		console.log(`${pack.name} (${pack.slug}) already exists on ${host}; nothing changed. Pass --update to refresh its content.`);
	} else {
		console.log(`Updated ${pack.name} (${pack.slug}) on ${host}: ${result.changes.length > 0 ? result.changes.join(', ') : 'nothing to change'}.`);
		console.log('  The catalog, campaigns, members and hosts are never changed by an update.');
	}
} catch (error) {
	console.error(error instanceof ClientPackRefusedError ? error.message : error);
	process.exitCode = 1;
} finally {
	await handle.close();
}
