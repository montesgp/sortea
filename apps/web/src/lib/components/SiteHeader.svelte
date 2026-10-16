<script lang="ts">
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
			<a class="cart" href="/carrito">
				Carrito
				{#if cartCount > 0}<span class="count" aria-label="{cartCount} productos">{cartCount}</span>{/if}
			</a>
			<form method="POST" action="/modo">
				<input type="hidden" name="back" value={page.url.pathname} />
				<button class="mode" name="mode" value={mode === 'dark' ? 'light' : 'dark'} aria-label={mode === 'dark' ? 'Usar tema claro' : 'Usar tema oscuro'}>
					<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
						{#if mode === 'dark'}
							<circle cx="12" cy="12" r="4.5" fill="currentColor" />
							<g stroke="currentColor" stroke-width="2" stroke-linecap="round">
								<path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
							</g>
						{:else}
							<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" fill="currentColor" />
						{/if}
					</svg>
				</button>
			</form>
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

	.cart {
		gap: 0.4rem;
	}

	.count {
		display: inline-grid;
		place-items: center;
		min-width: 1.4rem;
		height: 1.4rem;
		padding-inline: 0.3rem;
		border-radius: 999px;
		background: var(--accent);
		color: var(--accent-text);
		font-size: 0.75rem;
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
