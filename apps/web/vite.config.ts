import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';

const mercadoPago: `https://${string}.${string}`[] = ['https://*.mercadopago.com.ar', 'https://*.mercadopago.com', 'https://*.mercadolibre.com'];

export default defineConfig({
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
					'img-src': ['self', 'data:', 'https:'],
					'font-src': ['self'],
					'connect-src': ['self'],
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
});
