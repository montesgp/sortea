<script lang="ts">
	import { flushSync } from 'svelte';
	import { page } from '$app/state';
	import { galleryInMenu } from '#lib/gallery.js';
	import type { SiteData } from '#lib/server/types.js';

	interface Props {
		site: SiteData;
		cartCount: number;
		mode: 'dark' | 'light';
		/** Campaign pages use a reduced navigation (FR-CMS-02). */
		variant?: 'site' | 'campaign';
	}

	let { site, cartCount, mode, variant = 'site' }: Props = $props();
	// Light or dark is a passing choice (feedback 2026-10-19): switched here only, never sent or
	// stored, so the next load uses the site's default again.
	// svelte-ignore state_referenced_locally
	let shownMode = $state(mode);

	function switchMode() {
		const next = shownMode === 'dark' ? 'light' : 'dark';
		const root = document.documentElement;
		const apply = () => {
			root.dataset.mode = next;
			flushSync(() => (shownMode = next));
		};
		const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
		if (!still && document.startViewTransition) {
			document.startViewTransition(apply);
			return;
		}
		// Without view transitions, colors ease for a moment instead of jumping.
		if (!still) root.classList.add('mode-changing');
		apply();
		setTimeout(() => root.classList.remove('mode-changing'), 350);
	}
	const brand = $derived(site.content.brand);
	const gallery = $derived(galleryInMenu(site.content));
	const links = $derived(
		variant === 'campaign'
			? [
					{ href: '/sorteos', label: 'Campañas' },
					{ href: '/tienda', label: 'Productos' },
					{ href: '/consulta', label: 'Mis compras' }
				]
			: [
					{ href: '/', label: 'Inicio' },
					{ href: '/sorteos', label: 'Campañas' },
					{ href: '/tienda', label: 'Tienda' },
					...(gallery ? [{ href: '/restauraciones', label: gallery.title }] : []),
					{ href: '/consulta', label: 'Consultar' }
				]
	);
	const current = (href: string) => (href === '/' ? page.url.pathname === '/' : page.url.pathname.startsWith(href));
</script>

<header class="header" class:campaign={variant === 'campaign'}>
	<div class="container bar">
		<a class="brand" href="/" aria-label="{site.organization.name}, inicio">
			{#if brand?.logo}
				<img src={brand.logo.replace(/logo\.png$/, 'logo-180.png')} alt="" width="56" height="44" />
			{/if}
			<span class:visually-hidden={Boolean(brand?.logo)}>{site.organization.name}</span>
		</a>

		<nav aria-label="Principal">
			<ul>
				{#each links as link (link.href)}
					<li><a href={link.href} aria-current={current(link.href) ? 'page' : undefined}>{link.label}</a></li>
				{/each}
			</ul>
		</nav>

		<div class="tools">
			<a class="cart" href="/carrito" aria-label={cartCount > 0 ? `Carrito, ${cartCount} ${cartCount === 1 ? 'producto' : 'productos'}` : 'Carrito'}>
				<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
					<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
						<path d="M2 3h3l2.6 12.2a1 1 0 0 0 1 .8h9.2a1 1 0 0 0 1-.8L20.5 7H6.2" />
					</g>
					<circle cx="9.5" cy="20" r="1.6" fill="currentColor" />
					<circle cx="17.5" cy="20" r="1.6" fill="currentColor" />
				</svg>
				{#if cartCount > 0}<span class="count" aria-hidden="true">{cartCount}</span>{/if}
			</a>
			<div class="mode-slot">
				<button type="button" class="mode" onclick={switchMode} aria-label={shownMode === 'dark' ? 'Usar tema claro' : 'Usar tema oscuro'}>
					<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
						{#if shownMode === 'dark'}
							<circle cx="12" cy="12" r="4.5" fill="currentColor" />
							<g stroke="currentColor" stroke-width="2" stroke-linecap="round">
								<path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
							</g>
						{:else}
							<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" fill="currentColor" />
						{/if}
					</svg>
				</button>
			</div>
		</div>
	</div>
</header>

<style>
	.header {
		position: sticky;
		top: 0;
		z-index: 40;
		background: color-mix(in srgb, var(--bg) 86%, transparent);
		backdrop-filter: blur(10px);
		border-bottom: 1px solid color-mix(in srgb, var(--border) 70%, transparent);
	}

	/* Links, cart and the theme switch share one height so the bar reads as a row. */
	.bar {
		--control: 2rem;
		display: flex;
		align-items: center;
		gap: 1.5rem;
		min-height: 68px;
	}

	.brand {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		text-decoration: none;
		font: 800 var(--step-1) / 1 var(--font-display);
	}

	.brand img {
		width: 56px;
		height: auto;
	}

	nav {
		margin-inline-start: auto;
	}

	ul {
		display: flex;
		gap: clamp(0.8rem, 0.4rem + 1.4vw, 2rem);
		list-style: none;
		margin: 0;
		padding: 0;
	}

	nav a,
	.cart {
		display: inline-flex;
		align-items: center;
		height: var(--control);
		text-decoration: none;
		font-weight: 600;
		font-size: var(--step--1);
		border-block: 2px solid transparent;
	}

	nav a[aria-current='page'] {
		border-bottom-color: var(--accent);
	}

	nav a:hover {
		border-bottom-color: color-mix(in srgb, var(--accent) 50%, transparent);
	}

	.tools {
		display: flex;
		align-items: center;
		gap: 0.75rem;
	}

	/* Drawn at the control size; the ::after extends the tap area to 44px. */
	.cart {
		position: relative;
		justify-content: center;
		min-width: var(--control);
	}

	.cart::after {
		content: '';
		position: absolute;
		/* Measured from inside the 2px block borders shared with the nav links. */
		inset: calc((var(--control) - 44px) / 2 - 2px) calc((var(--control) - 44px) / 2);
	}

	.cart:hover {
		color: var(--accent);
	}

	.count {
		position: absolute;
		top: -0.3rem;
		inset-inline-end: -0.55rem;
		display: inline-grid;
		place-items: center;
		min-width: 1.15rem;
		height: 1.15rem;
		padding-inline: 0.25rem;
		line-height: 1;
		border-radius: 999px;
		background: var(--accent);
		color: var(--accent-text);
		font-size: 0.7rem;
	}

	.mode {
		display: grid;
		place-items: center;
		width: var(--control);
		height: var(--control);
		border: 1px solid var(--border);
		border-radius: 50%;
		background: transparent;
		color: var(--text);
		cursor: pointer;
	}

	@media (max-width: 760px) {
		.bar {
			flex-wrap: wrap;
			gap: 0.5rem 1rem;
			padding-block: 0.5rem;
		}

		nav {
			order: 3;
			width: 100%;
			margin: 0;
			overflow-x: auto;
		}

		.tools {
			margin-inline-start: auto;
		}
	}
</style>
