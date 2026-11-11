import { fileURLToPath } from 'node:url';
import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';
import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';
import { clientStatic } from './plugins/client-static.ts';

const mercadoPago: `https://${string}.${string}`[] = ['https://*.mercadopago.com.ar', 'https://*.mercadopago.com', 'https://*.mercadolibre.com'];

/**
 * Site images and videos live in the S3 bucket and the site links them as
 * `/media/<path>`, which redirects to a presigned URL on the bucket (ADR 0020).
 * Images may also come from any https origin (prize photos by URL); videos only
 * from the bucket, so `img-src` and `media-src` name its origin,
 * `MEDIA_PUBLIC_ORIGIN`, read at build time (ADR 0009). Local MinIO serves http
 * on loopback, which is allowed only for loopback hosts and only by the dev
 * server, so neither a real http origin nor a local one reaches a production build.
 */
type Origin = `http://${string}.${string}` | `https://${string}.${string}`;

function env(key: string): string | undefined {
	return process.env[key] || loadEnv('development', '../../', '')[key] || undefined;
}

function originOf(url: string | undefined, command: 'serve' | 'build'): Origin | null {
	if (!url) return null;
	const parsed = new URL(url);
	if (parsed.protocol === 'https:') return parsed.origin as Origin;
	const loopback = parsed.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(parsed.hostname);
	return loopback && command === 'serve' ? (parsed.origin as Origin) : null;
}

function mediaOrigins(command: 'serve' | 'build'): Origin[] {
	const origin = originOf(env('MEDIA_PUBLIC_ORIGIN'), command);
	if (!origin && command === 'build') console.warn('[csp] No https MEDIA_PUBLIC_ORIGIN at build time: uploaded images and videos will not load (ADR 0020).');
	return origin ? [origin] : [];
}

export default defineConfig(({ command }) => {
	const media = mediaOrigins(command);
	return {
		// One .env for the whole monorepo (see env.template); SvelteKit reads it through Vite in dev.
		envDir: '../../',
		plugins: [
			// Images of the private client packs keep their /tenants/<client>/ URLs (clients/README.md in the private repository).
			...clientStatic({ clientsDir: fileURLToPath(new URL('../../clients', import.meta.url)), publicDir: fileURLToPath(new URL('./static', import.meta.url)) }),
			sveltekit({
				compilerOptions: {
					runes: ({ filename }) => (filename.split(/[/\\]/).includes('node_modules') ? undefined : true)
				},
				adapter: adapter(),
				csp: {
					mode: 'auto',
					directives: {
						'default-src': ['self'],
						'script-src': ['self'],
						'style-src': ['self'],
						// Svelte renders some style attributes (custom properties); element styles still need a nonce.
						'style-src-attr': ['unsafe-inline'],
						'img-src': ['self', 'data:', 'https:', ...media],
						// Uploaded videos (S9), only from the bucket.
						'media-src': ['self', ...media],
						'font-src': ['self'],
						'connect-src': ['self'],
						// YouTube links (home video, stream, campaign and prize videos) always use the privacy-enhanced embed.
						'frame-src': ['https://www.youtube-nocookie.com'],
						// Checkout posts here and is redirected to Mercado Pago.
						'form-action': ['self', ...mercadoPago],
						'frame-ancestors': ['none'],
						'base-uri': ['self'],
						'object-src': ['none']
					}
				}
			})
		],
		server: { port: 5173, strictPort: true },
		test: {
			expect: { requireAssertions: true },
			include: ['src/**/*.{test,spec}.ts', 'plugins/**/*.test.ts']
		}
	};
});
