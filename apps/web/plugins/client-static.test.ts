import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { clientStatic, clientStaticFiles } from './client-static';

const root = mkdtempSync(join(tmpdir(), 'client-static-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function file(path: string, content = path) {
	mkdirSync(join(root, path, '..'), { recursive: true });
	writeFileSync(join(root, path), content);
}

file('clients/acme/static/tenants/acme/logo.png', 'png');
file('clients/acme/static/tenants/acme/premios/moto.jpg', 'jpg');
file('clients/beta/static/tenants/beta/hero.webp', 'webp');
file('clients/beta/static/tenants/shared.txt', 'from beta');
file('clients/acme/static/tenants/shared.txt', 'from acme');
file('clients/gamma/pack.ts', 'no static directory');
file('apps/web/static/tenants/acme/logo.png', 'public wins');
file('secret.txt', 'outside every static directory');

const options = { clientsDir: join(root, 'clients'), publicDir: join(root, 'apps/web/static') };

describe('clientStaticFiles', () => {
	it('lists the files of every clients/*/static by URL path, the public directory and the first client winning on a clash', () => {
		const files = clientStaticFiles(options);
		expect([...files.keys()].sort()).toEqual(['/tenants/acme/premios/moto.jpg', '/tenants/beta/hero.webp', '/tenants/shared.txt']);
		expect(files.get('/tenants/shared.txt')).toBe(join(root, 'clients/acme/static/tenants/shared.txt'));
	});

	it('is empty without a clients directory, as in the public copy', () => {
		expect(clientStaticFiles({ clientsDir: join(root, 'missing'), publicDir: options.publicDir }).size).toBe(0);
	});
});

/** Runs the dev middleware for one request and records what it answers. */
async function request(url: string, method = 'GET') {
	const [serve] = clientStatic(options);
	let middleware: ((req: IncomingMessage, res: ServerResponse, next: () => void) => void) | undefined;
	(serve!.configureServer as (server: unknown) => void)({ middlewares: { use: (fn: typeof middleware) => (middleware = fn) } });
	const sent: { status?: number; headers: Record<string, string>; body: string; next: boolean } = { headers: {}, body: '', next: false };
	await new Promise<void>((done) => {
		const res = {
			statusCode: 200,
			setHeader: (name: string, value: string) => void (sent.headers[name.toLowerCase()] = value),
			end: (chunk?: Buffer | string) => {
				sent.status = res.statusCode;
				if (chunk) sent.body += chunk.toString();
				done();
			}
		};
		middleware!({ url, method } as IncomingMessage, res as unknown as ServerResponse, () => {
			sent.next = true;
			done();
		});
	});
	return sent;
}

describe('clientStatic in development', () => {
	it('serves a client file at its URL with its content type', async () => {
		expect(await request('/tenants/acme/premios/moto.jpg?v=1')).toMatchObject({ status: 200, body: 'jpg', next: false, headers: { 'content-type': 'image/jpeg', 'cache-control': 'no-cache' } });
		expect(await request('/tenants/beta/hero.webp', 'HEAD')).toMatchObject({ status: 200, body: '', headers: { 'content-type': 'image/webp' } });
	});

	it('passes everything else on: other paths, other methods, traversal and files the public directory has', async () => {
		for (const [url, method] of [
			['/tenants/acme/missing.png', 'GET'],
			['/tenants/acme/premios/moto.jpg', 'POST'],
			['/tenants/../../secret.txt', 'GET'],
			['/tenants/%2e%2e/%2e%2e/secret.txt', 'GET'],
			['/tenants/acme/logo.png', 'GET'],
			['/tenants/acme', 'GET']
		]) {
			expect(await request(url!, method), url).toMatchObject({ next: true, body: '' });
		}
	});
});

describe('clientStatic in a build', () => {
	function emitted(consumer: 'client' | 'server') {
		const [, build] = clientStatic(options);
		const files: { type: string; fileName: string; source: string }[] = [];
		(build!.generateBundle as (this: unknown) => void).call({
			environment: { config: { consumer } },
			emitFile: (asset: { type: string; fileName: string; source: Uint8Array }) => void files.push({ ...asset, source: Buffer.from(asset.source).toString() })
		});
		return files.sort((a, b) => a.fileName.localeCompare(b.fileName));
	}

	it('emits every client file into the client output at its URL path', () => {
		expect(emitted('client')).toEqual([
			{ type: 'asset', fileName: 'tenants/acme/premios/moto.jpg', source: 'jpg' },
			{ type: 'asset', fileName: 'tenants/beta/hero.webp', source: 'webp' },
			{ type: 'asset', fileName: 'tenants/shared.txt', source: 'from acme' }
		]);
	});

	it('emits nothing into the server output', () => {
		expect(emitted('server')).toEqual([]);
	});
});
