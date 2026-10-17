<script lang="ts">
	import type { SiteData } from '#lib/server/types.js';
	import { whatsappHref } from '#lib/whatsapp.js';

	let { site }: { site: SiteData } = $props();
	const year = new Date().getFullYear();
	const whatsapp = $derived(whatsappHref(site.contact.whatsapp));
</script>

<footer class="footer" class:with-whatsapp={whatsapp}>
	<div class="container grid">
		<div>
			<p class="name">{site.organization.name}</p>
			{#if site.content.brand?.tagline}<p class="muted">{site.content.brand.tagline}</p>{/if}
			{#if site.contact.city}<p class="muted">{site.contact.city}</p>{/if}
		</div>
		<nav aria-label="Pie de página">
			<ul>
				<li><a href="/sorteos">Campañas</a></li>
				<li><a href="/tienda">Tienda</a></li>
				<li><a href="/consulta">Consultar mis compras</a></li>
				<li><a href="/legales/terminos">Términos y condiciones</a></li>
				<li><a href="/legales/privacidad">Privacidad y datos personales</a></li>
			</ul>
		</nav>
		<div class="social">
			{#if site.social.instagram}<a href={site.social.instagram} rel="noopener" target="_blank">Instagram</a>{/if}
			{#if site.social.youtube}<a href={site.social.youtube} rel="noopener" target="_blank">YouTube</a>{/if}
			{#if site.social.tiktok}<a href={site.social.tiktok} rel="noopener" target="_blank">TikTok</a>{/if}
			{#if whatsapp}<a href={whatsapp} rel="noopener" target="_blank">WhatsApp</a>{/if}
		</div>
	</div>
	<div class="container legal muted">
		<p>© {year} {site.organization.name}. Los datos personales se tratan según la Ley 25.326. Podés pedir acceso, rectificación o supresión desde Consultar.</p>
	</div>
</footer>

<style>
	.footer {
		margin-top: clamp(4rem, 3rem + 4vw, 7rem);
		border-top: 1px solid var(--border);
		padding-block: 3rem 2rem;
		font-size: var(--step--1);
	}

	/* Room for the floating WhatsApp button below the last line. */
	.footer.with-whatsapp {
		padding-bottom: calc(2rem + 56px + 1rem);
	}

	.grid {
		display: grid;
		grid-template-columns: 1.4fr 1fr 1fr;
		gap: 2rem;
	}

	.name {
		font: 800 var(--step-2) / 1 var(--font-display);
		margin-bottom: 0.5rem;
	}

	ul {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 0.45rem;
	}

	.social {
		display: grid;
		align-content: start;
		gap: 0.45rem;
	}

	.legal {
		margin-top: 2.5rem;
		padding-top: 1.25rem;
		border-top: 1px solid color-mix(in srgb, var(--border) 60%, transparent);
	}

	@media (max-width: 760px) {
		.grid {
			grid-template-columns: 1fr;
		}
	}
</style>
