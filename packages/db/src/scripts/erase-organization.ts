import postgres from 'postgres';
import { ErasureRefusedError, eraseOrganization, organizationObjectStorage, planErasure, type ErasurePlan, type OrganizationStorage } from '../erase-organization';
import { createObjectStore, objectStoreConfigFromEnv, ObjectStoreConfigError, type ObjectStore } from '../object-store';
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

/** The environment's S3 bucket (product-assets/ and site-media/); null, with a warning, when not configured. */
function bucketStorage(): { storage: OrganizationStorage; location: string } | null {
	let store: ObjectStore;
	try {
		store = createObjectStore(objectStoreConfigFromEnv());
	} catch (error) {
		if (!(error instanceof ObjectStoreConfigError)) throw error;
		console.warn(`Warning: ${error.message} Storage files are not counted or removed.`);
		return null;
	}
	return { storage: organizationObjectStorage(store), location: store.location };
}

function printPlan(plan: ErasurePlan, host: string, storageLocation: string | null): void {
	const { id, slug, name } = plan.organization;
	console.log(`Database: ${host}`);
	console.log(`Organization: ${name} (slug ${slug}, id ${id})`);
	const tables = Object.entries(plan.counts);
	console.log(`Rows: ${tables.reduce((sum, [, n]) => sum + n, 0)} in ${tables.length} tables, plus the organization row`);
	for (const [table, n] of tables) console.log(`  ${table}: ${n}`);
	if (plan.storageCounts) {
		console.log(`Storage files under ${id}/ in ${storageLocation}:`);
		for (const [area, n] of Object.entries(plan.storageCounts)) console.log(`  ${area}/: ${n}`);
	}
	if (plan.productionPaymentIntegrations > 0) console.log('Mercado Pago: production mode (erasing needs --allow-production)');
}

const url = databaseUrl();
const host = new URL(url).host;
const sql = postgres(url, { max: 1, onnotice: () => {} });
try {
	const args = parseArgs(process.argv.slice(2));
	const bucket = bucketStorage();
	const storage = bucket?.storage ?? null;
	const location = bucket?.location ?? null;
	if (args.confirm === undefined) {
		printPlan(await planErasure(sql, args.slug, storage), host, location);
		console.log(`Dry run: nothing was deleted. To erase, run again with --confirm ${args.slug}`);
	} else {
		// Files are part of the organization: erasing only its rows needs an explicit choice.
		if (!storage && !args.skipStorage) {
			throw new ErasureRefusedError(`Refusing to erase ${args.slug}: storage is not configured, so its files would stay. Set the S3 variables, or add --skip-storage.`);
		}
		// What is about to go, and where, before anything is deleted.
		printPlan(await planErasure(sql, args.slug, storage), host, location);
		if (args.skipStorage) console.log('Storage: skipped (--skip-storage); the files stay.');
		const result = await eraseOrganization(sql, { slug: args.slug, confirm: args.confirm, allowProduction: args.allowProduction, storage, skipStorage: args.skipStorage });
		console.log(`Erased organization ${result.organization.slug} (${result.organization.id}) and recorded organization.erased in the audit log`);
		if (result.storageRemoved) {
			for (const [area, n] of Object.entries(result.storageRemoved)) console.log(`  removed from ${area}/: ${n}`);
		}
		if (result.storageErrors.length > 0) {
			console.error(`Storage cleanup failed; delete ${result.organization.id}/ under these prefixes of the bucket by hand:`);
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
