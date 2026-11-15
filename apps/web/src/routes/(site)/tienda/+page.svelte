<script lang="ts">
	import CampaignBand from '#lib/components/CampaignBand.svelte';
	import ProductCard from '#lib/components/ProductCard.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<svelte:head>
	<title>Tienda | {data.site?.organization.name}</title>
	<meta name="description" content="Productos digitales y físicos de {data.site?.organization.name}." />
</svelte:head>

<!--
	The shop is the page linked from social media, where the campaign is already
	explained (owner feedback 2026-11-15 S1): a plain heading, the products right
	after it, and the campaign data after the last product.
-->
<section class="container page" id="productos" aria-labelledby="shop-title">
	<h1 id="shop-title">{data.featured ? `Participaciones por ${data.featured.title}` : 'Tienda'}</h1>
	<p class="muted lead">Comprás sin crear una cuenta. Los productos digitales llegan a tu email apenas se confirma el pago.</p>

	{#if data.unavailable}
		<p class="notice error">La tienda no está disponible en este momento. Probá de nuevo en unos minutos.</p>
	{:else if data.products.length === 0}
		<p class="notice">Todavía no hay productos publicados.</p>
	{:else}
		<div class="grid">
			{#each data.products as product (product.id)}
				<ProductCard {product} chances={data.chances} />
			{/each}
		</div>
	{/if}
</section>

{#if data.featured}
	<CampaignBand campaign={data.featured} serverTime={data.serverTime} timezone={data.site!.organization.timezone} example={data.example} />
{/if}

<style>
	.page {
		padding-block: clamp(2rem, 1.5rem + 2vw, 3.5rem) clamp(2.5rem, 2rem + 3vw, 5rem);
		scroll-margin-top: 5rem;
	}

	/* A plain heading: the products are what this page leads with (S1). */
	h1 {
		font-size: var(--step-3);
		text-transform: uppercase;
	}

	.lead {
		margin: 0.5rem 0 1.5rem;
		max-width: 60ch;
	}

	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
		/* Every row as tall as the tallest card, so all cards share one layout (S4). */
		grid-auto-rows: 1fr;
		gap: 1.25rem;
	}
</style>
