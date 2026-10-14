<script lang="ts">
	import ProductCard from '#lib/components/ProductCard.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<svelte:head>
	<title>Tienda | {data.site?.organization.name}</title>
	<meta name="description" content="Productos digitales y físicos de {data.site?.organization.name}." />
</svelte:head>

<section class="container page">
	<h1>Tienda</h1>
	<p class="muted lead">Comprás sin crear una cuenta. Los productos digitales llegan a tu email apenas se confirma el pago.</p>

	{#if data.unavailable}
		<p class="notice error">La tienda no está disponible en este momento. Probá de nuevo en unos minutos.</p>
	{:else if data.products.length === 0}
		<p class="notice">Todavía no hay productos publicados.</p>
	{:else}
		<div class="grid">
			{#each data.products as product (product.id)}
				<ProductCard {product} />
			{/each}
		</div>
	{/if}
</section>

<style>
	.page {
		padding-top: clamp(2.5rem, 2rem + 3vw, 5rem);
	}

	h1 {
		font-size: var(--step-5);
		text-transform: uppercase;
	}

	.lead {
		margin: 1rem 0 2.5rem;
		max-width: 60ch;
		font-size: var(--step-1);
	}

	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
		gap: 1.25rem;
	}
</style>
