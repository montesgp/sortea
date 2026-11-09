import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import type { Plugin } from 'vite';

/**
 * Serves the static files of the private client packs (`clients/<client>/static`)
 * as if they were in `apps/web/static`, so a client's images keep their URLs
 * (`/tenants/<client>/...`) while they live outside the shared code. The dev
 * server answers them from disk and a build copies them into the client output,
 * next to the public directory's files. The public copy of the repository has
 * no `clients/`, so there it adds nothing.
 *
 * A file the public directory also has is left to it; when two clients have the
 * same path, the first one in alphabetical order wins.
 */
export interface ClientStaticOptions {
	clientsDir: string;
	publicDir: string;
}

const contentTypes: Record<string, string> = {
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.png': 'image/png',
	'.webp': 'image/webp',
	'.gif': 'image/gif',
	'.svg': 'image/svg+xml',
	'.ico': 'image/x-icon',
	'.mp4': 'video/mp4',
	'.webm': 'video/webm',
	'.pdf': 'application/pdf',
	'.md': 'text/markdown; charset=utf-8',
	'.txt': 'text/plain; charset=utf-8'
};

function walk(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		return entry.isDirectory() ? walk(path) : entry.isFile() ? [path] : [];
	});
}

/** URL path (`/tenants/acme/logo.png`) to file, for every client's static directory. */
export function clientStaticFiles(options: ClientStaticOptions): Map<string, string> {
	const files = new Map<string, string>();
	if (!existsSync(options.clientsDir)) return files;
	for (const client of readdirSync(options.clientsDir).sort()) {
		const dir = join(options.clientsDir, client, 'static');
		if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
		for (const file of walk(dir)) {
			const path = relative(dir, file).split(sep).join('/');
			if (files.has(`/${path}`) || existsSync(join(options.publicDir, path))) continue;
			files.set(`/${path}`, file);
		}
	}
	return files;
}

export function clientStatic(options: ClientStaticOptions): Plugin[] {
	return [
		{
			name: 'sortea:client-static-serve',
			apply: 'serve',
			configureServer(server) {
				// Before Vite's and SvelteKit's own handlers; listed per request, so a file added to a pack shows without a restart.
				server.middlewares.use((req, res, next) => {
					if (req.method !== 'GET' && req.method !== 'HEAD') return next();
					let path: string;
					try {
						path = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
					} catch {
						return next();
					}
					const file = path.split('/').includes('..') ? undefined : clientStaticFiles(options).get(path);
					if (!file) return next();
					res.statusCode = 200;
					res.setHeader('Content-Type', contentTypes[extname(file).toLowerCase()] ?? 'application/octet-stream');
					res.setHeader('Cache-Control', 'no-cache');
					res.end(req.method === 'HEAD' ? undefined : readFileSync(file));
				});
			}
		},
		{
			name: 'sortea:client-static-build',
			apply: 'build',
			generateBundle() {
				// Only the browser build; its output directory is what the Node adapter serves as static files.
				if (this.environment.config.consumer !== 'client') return;
				for (const [path, file] of clientStaticFiles(options)) {
					this.emitFile({ type: 'asset', fileName: path.slice(1), source: readFileSync(file) });
				}
			}
		}
	];
}
