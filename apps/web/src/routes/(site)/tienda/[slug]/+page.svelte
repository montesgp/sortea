<script lang="ts">
	import { enhance } from '$app/forms';
	import VariantFields from '#lib/components/VariantFields.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const product = $derived(data.product);
	// Seeded once from the first option in stock; the buyer's choice is kept from then on.
	// svelte-ignore state_referenced_locally
	let selectedId = $state(data.product.variants.find((option) => option.inStock)?.id);
	let quantity = $state(1);
	let adding = $state(false);
</script>

<svelte:head>
	<title>{product.name} | {data.site?.organization.name}</title>
	<meta name="description" content={product.description} />
</svelte:head>

<section class="container page" aria-labelledby="product-title">
	<a class="back" href="/tienda">Volver a la tienda</a>
	<div class="layout">
		<div class="art" aria-hidden="true">
			{#if product.imageUrl}<img src={product.imageUrl} alt="" />{/if}
		</div>
		<div class="detail">
			<h1 id="product-title">{product.name}</h1>
			<p class="muted">{product.description}</p>
			{#if product.variants.some((option) => option.inStock)}
				<form
					method="POST"
					action="?/add"
					use:enhance={() => {
						adding = true;
						return async ({ update }) => {
							await update({ reset: false });
							adding = false;
						};
					}}
				>
					<VariantFields {product} chances={data.chances} idPrefix="product-{product.id}" bind:selectedId bind:quantity />
					{#if data.campaign}<input type="hidden" name="campaign" value={data.campaign} />{/if}
					{#if form?.message}<p class="notice error" role="alert">{form.message}</p>{/if}
					<button class="button" disabled={adding}>Agregar</button>
				</form>
			{:else}
				<p class="chip neutral">Sin stock</p>
			{/if}
		</div>
	</div>
</section>

<style>
	.page {
		padding-block: clamp(2rem, 1.5rem + 3vw, 4rem);
	}

	.back {
		display: inline-block;
		margin-bottom: 1.5rem;
	}

	.layout {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 1.1fr);
		gap: clamp(1.5rem, 1rem + 3vw, 3rem);
		align-items: start;
	}

	.art {
		aspect-ratio: 1;
		border-radius: var(--radius);
		background: var(--surface-2);
		overflow: hidden;
	}

	.art img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.detail {
		display: grid;
		gap: 1rem;
	}

	h1 {
		font-size: var(--step-4);
		text-transform: uppercase;
	}

	form {
		display: grid;
		gap: 1.25rem;
		margin-top: 0.5rem;
	}

	form .button {
		justify-self: start;
		min-width: 12rem;
	}

	@media (max-width: 720px) {
		.layout {
			grid-template-columns: 1fr;
		}

		.art {
			aspect-ratio: 16 / 10;
		}
	}
</style>
