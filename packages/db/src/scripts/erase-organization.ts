import { createClient } from '@supabase/supabase-js';
import postgres from 'postgres';
import { ErasureRefusedError, eraseOrganization, planErasure, type ErasurePlan, type OrganizationStorage } from '../erase-organization';
import { databaseUrl } from './env';

/**
 * Erases one organization on the owner's explicit request (ADR 0011).
 *
 *   pnpm db:erase-org <slug>                       dry run: prints what would go
 *   pnpm db:erase-org <slug> --confirm <slug>      erases
 *   ... --allow-production                         also when Mercado Pago is in production mode
 *   ... --skip-storage                             erase rows even without storage credentials (files stay)
 *
 * Irreversible: backups are the only way back.
 */
const usage = 'Usage: pnpm db:erase-org <slug> [--confirm <slug>] [--allow-production] [--skip-storage]';

interface Args {
	slug: string;
	confirm: string | undefined;
	allowProduction: boolean;
	skipStorage: boolean;
}

function parseArgs(argv: string[]): Args {
	let slug: string | undefined;
	let confirm: string | undefined;
	let allowProduction = false;
	let skipStorage = false;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (arg === '--confirm') {
			confirm = argv[++i];
			if (confirm === undefined) throw new ErasureRefusedError(`--confirm needs the slug. ${usage}`);
		} else if (arg === '--allow-production') {
			allowProduction = true;
		} else if (arg === '--skip-storage') {
			skipStorage = true;
		} else if (arg.startsWith('-') || slug !== undefined) {
			throw new ErasureRefusedError(`Unexpected argument ${arg}. ${usage}`);
		} else {
			slug = arg;
		}
	}
	if (!slug) throw new ErasureRefusedError(usage);
	return { slug, confirm, allowProduction, skipStorage };
}

/** Supabase Storage with the API's buckets; null (with a warning) when not configured. */
function supabaseStorage(): OrganizationStorage | null {
	const url = process.env.SUPABASE_URL;
	const secretKey = process.env.SUPABASE_SECRET_KEY;
	if (!url || !secretKey) {
		console.warn('Warning: SUPABASE_URL or SUPABASE_SECRET_KEY is not set; storage files are not counted or removed.');
		return null;
	}
	const storage = createClient(url, secretKey, { auth: { persistSession: false, autoRefreshToken: false } }).storage;
	const buckets = [process.env.STORAGE_BUCKET ?? 'product-assets', process.env.MEDIA_BUCKET ?? 'site-media'];

	async function list(bucket: string, prefix: string): Promise<string[]> {
		const paths: string[] = [];
		const folder = prefix.replace(/\/$/, '');
		for (let offset = 0; ; offset += 1000) {
			const { data, error } = await storage.from(bucket).list(folder, { limit: 1000, offset });
			if (error) {
				if (/not found/i.test(error.message)) return paths;
				throw new Error(`Could not list ${bucket}/${folder}: ${error.message}`);
			}
			for (const entry of data) {
				const path = `${folder}/${entry.name}`;
				// Folders have no id; their contents are listed one level down.
				if (entry.id === null) paths.push(...(await list(bucket, `${path}/`)));
				else paths.push(path);
			}
			if (data.length < 1000) return paths;
		}
	}

	return {
		buckets,
		list,
		async remove(bucket, paths) {
			const { error } = await storage.from(bucket).remove(paths);
			if (error) throw new Error(`Could not remove files: ${error.message}`);
		}
	};
}

function printPlan(plan: ErasurePlan, host: string): void {
	const { id, slug, name } = plan.organization;
	console.log(`Database: ${host}`);
	console.log(`Organization: ${name} (slug ${slug}, id ${id})`);
	const tables = Object.entries(plan.counts);
	console.log(`Rows: ${tables.reduce((sum, [, n]) => sum + n, 0)} in ${tables.length} tables, plus the organization row`);
	for (const [table, n] of tables) console.log(`  ${table}: ${n}`);
	if (plan.storageCounts) {
		console.log(`Storage files under ${id}/:`);
		for (const [bucket, n] of Object.entries(plan.storageCounts)) console.log(`  ${bucket}: ${n}`);
	}
	if (plan.productionPaymentIntegrations > 0) console.log('Mercado Pago: production mode (erasing needs --allow-production)');
}

const url = databaseUrl();
const host = new URL(url).host;
const sql = postgres(url, { max: 1, onnotice: () => {} });
try {
	const args = parseArgs(process.argv.slice(2));
	const storage = supabaseStorage();
	if (args.confirm === undefined) {
		printPlan(await planErasure(sql, args.slug, storage), host);
		console.log(`Dry run: nothing was deleted. To erase, run again with --confirm ${args.slug}`);
	} else {
		// Files are part of the organization: erasing only its rows needs an explicit choice.
		if (!storage && !args.skipStorage) {
			throw new ErasureRefusedError(`Refusing to erase ${args.slug}: storage is not configured, so its files would stay. Set SUPABASE_URL and SUPABASE_SECRET_KEY, or add --skip-storage.`);
		}
		// What is about to go, and where, before anything is deleted.
		printPlan(await planErasure(sql, args.slug, storage), host);
		const result = await eraseOrganization(sql, { slug: args.slug, confirm: args.confirm, allowProduction: args.allowProduction, storage });
		console.log(`Erased organization ${result.organization.slug} (${result.organization.id}) and recorded organization.erased in the audit log`);
		if (result.storageRemoved) {
			for (const [bucket, n] of Object.entries(result.storageRemoved)) console.log(`  removed from ${bucket}: ${n}`);
		}
		if (result.storageErrors.length > 0) {
			console.error(`Storage cleanup failed; delete ${result.organization.id}/ from these buckets by hand:`);
			for (const error of result.storageErrors) console.error(`  ${error}`);
			process.exitCode = 1;
		}
	}
} catch (error) {
	console.error(error instanceof ErasureRefusedError ? error.message : error);
	process.exitCode = 1;
} finally {
	await sql.end();
}
