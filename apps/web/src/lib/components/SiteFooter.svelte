<script lang="ts">
	import LegalLink from '#lib/components/legal/LegalLink.svelte';
	import SocialLinks from '#lib/components/SocialLinks.svelte';
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
				<li><LegalLink href="/legales/terminos">Términos y condiciones</LegalLink></li>
				<li><LegalLink href="/legales/privacidad">Privacidad y datos personales</LegalLink></li>
				<!-- Res. 424/2020: visible on every public page and reachable without registration (S12). -->
				<li><a class="withdrawal" href="/arrepentimiento">Botón de arrepentimiento</a></li>
			</ul>
		</nav>
		<div class="social" aria-label="Redes sociales" role="group">
			<!-- WhatsApp and the location share the networks' item so they line up (S3, S4). -->
			<SocialLinks social={site.social} {whatsapp} maps={site.contact.mapsUrl ?? null} />
		</div>
	</div>
	<div class="container legal muted">
		<p>© {year} {site.organization.name}. Los datos personales se tratan según la Ley 25.326. Podés pedir acceso, rectificación o supresión de tus datos por los canales de contacto de este sitio.</p>
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

	.withdrawal {
		justify-self: start;
		display: inline-block;
		margin-top: 0.35rem;
		padding: 0.45rem 0.85rem;
		border: 1px solid var(--accent);
		border-radius: var(--radius-sm);
		font-weight: 700;
		text-decoration: none;
	}

	.withdrawal:hover {
		background: color-mix(in srgb, var(--accent) 14%, transparent);
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
