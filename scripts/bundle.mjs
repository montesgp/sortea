// Compiles the API or the worker, with the workspace packages they use, into
// JavaScript under apps/<app>/dist, so deployed images start with plain
// `node dist/main.js` instead of tsx (ADR 0020, "Environments and cost").
// Packages from node_modules stay imports, and each one must be a dependency
// of the app itself: the image installs only the app's production
// dependencies (`pnpm install --prod`), so a package only a workspace package
// declares would be missing at run time. `pnpm dev` keeps running the sources with tsx.
//
//   node scripts/bundle.mjs api|worker
import { cpSync, existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const db = (script) => join(root, 'packages/db/src/scripts', script);

/** Operator commands shipped with each image, run as `node dist/<name>.js` (README, "Deploy"). */
const backupCommands = { backup: db('backup.ts'), backups: db('backups.ts'), restore: db('restore.ts') };

export const apps = {
	api: {
		entries: {
			main: join(root, 'apps/api/src/main.ts'),
			predeploy: db('predeploy.ts'),
			migrate: db('migrate.ts'),
			'admin-user': db('admin-user.ts'),
			'client-load': db('client-load.ts'),
			geo: db('import-geonames.ts'),
			'erase-org': db('erase-organization.ts'),
			'product-file': db('product-file.ts'),
			...backupCommands
		},
		migrations: true,
		packs: true
	},
	worker: {
		entries: { main: join(root, 'apps/worker/src/main.ts'), ...backupCommands },
		migrations: false,
		packs: false
	}
};

/** Client packs of the private repository (`clients/<client>/pack.ts`), compiled to `dist/packs/<client>.js` for `client-load`. */
function packEntries() {
	const dir = join(root, 'clients');
	if (!existsSync(dir)) return {};
	return Object.fromEntries(
		readdirSync(dir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && existsSync(join(dir, entry.name, 'pack.ts')))
			.map((entry) => [`packs/${entry.name}`, join(dir, entry.name, 'pack.ts')])
	);
}

/** `zod/mini` -> `zod`, `@aws-sdk/client-s3` -> itself. */
export function packageName(specifier) {
	const parts = specifier.split('/');
	return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/**
 * Workspace packages (`@sortea/*`, TypeScript sources) are compiled in; every
 * other package stays an import and must be one of `dependencies`.
 */
export function externalPackages(dependencies) {
	return {
		name: 'external-packages',
		setup(builder) {
			builder.onResolve({ filter: /^[^./]/ }, (args) => {
				if (args.kind === 'entry-point' || isAbsolute(args.path) || args.path.startsWith('@sortea/')) return undefined;
				if (isBuiltin(args.path)) return { path: args.path, external: true };
				const name = packageName(args.path);
				if (!dependencies.includes(name)) {
					return { errors: [{ text: `${name} is imported (from ${args.importer.slice(root.length + 1)}) but is not in the app's dependencies; add it to its package.json.` }] };
				}
				return { path: args.path, external: true };
			});
		}
	};
}

export async function bundle(name) {
	const app = apps[name];
	if (!app) throw new Error(`Unknown app ${name}: use ${Object.keys(apps).join(' or ')}`);
	const outdir = join(root, 'apps', name, 'dist');
	const manifest = JSON.parse(readFileSync(join(root, 'apps', name, 'package.json'), 'utf8'));
	rmSync(outdir, { recursive: true, force: true });
	await build({
		entryPoints: { ...app.entries, ...(app.packs ? packEntries() : {}) },
		outdir,
		bundle: true,
		splitting: true,
		format: 'esm',
		platform: 'node',
		target: 'node22',
		outExtension: { '.js': '.js' },
		// Chunks stay beside the entries: shared code finds `migrations/` and `packs/` relative to itself.
		chunkNames: '[name]-[hash]',
		plugins: [externalPackages(Object.keys(manifest.dependencies ?? {}))],
		logLevel: 'warning'
	});
	// The migrator looks for `migrations/` next to the bundle (packages/db/src/migrator.ts).
	if (app.migrations) cpSync(join(root, 'packages/db/migrations'), join(outdir, 'migrations'), { recursive: true });
	return outdir;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const name = process.argv[2];
	try {
		const outdir = await bundle(name);
		console.log(`Built ${name} into ${outdir}`);
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	}
}
