import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';
import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

const mercadoPago: `https://${string}.${string}`[] = ['https://*.mercadopago.com.ar', 'https://*.mercadopago.com', 'https://*.mercadolibre.com'];

/**
 * Site images and videos live in the public media bucket. Images may come from
 * any https origin (prize photos by URL); videos only from the bucket, so
 * `media-src` names its origin: `MEDIA_PUBLIC_ORIGIN` when the files are served
 * from elsewhere (a CDN or another storage), otherwise `SUPABASE_URL`, read at
 * build time (ADR 0009). Local Supabase serves http on loopback, which is
 * allowed only for loopback hosts and only by the dev server, so neither a
 * real http origin nor a local one reaches a production build.
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

function localMediaOrigins(command: 'serve' | 'build'): Origin[] {
	const origin = command === 'serve' ? originOf(env('SUPABASE_URL'), command) : null;
	return origin?.startsWith('http://') ? [origin] : [];
}

function videoOrigins(command: 'serve' | 'build'): Origin[] {
	const origin = originOf(env('MEDIA_PUBLIC_ORIGIN') ?? env('SUPABASE_URL'), command);
	if (!origin && command === 'build') console.warn('[csp] No MEDIA_PUBLIC_ORIGIN or https SUPABASE_URL at build time: uploaded videos will not play (ADR 0009).');
	return origin ? [origin] : [];
}

export default defineConfig(({ command }) => ({
	// One .env for the whole monorepo (see env.template); SvelteKit reads it through Vite in dev.
	envDir: '../../',
	plugins: [
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
					'img-src': ['self', 'data:', 'https:', ...localMediaOrigins(command)],
					// Uploaded videos (S9), only from the media bucket.
					'media-src': ['self', ...videoOrigins(command)],
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
		include: ['src/**/*.{test,spec}.ts']
	}
}));
