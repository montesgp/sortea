<script lang="ts">
	import { enhance } from '$app/forms';
	import ChancesBadge from '#lib/components/ChancesBadge.svelte';
	import { cardChances, type PublicChances } from '#lib/chances.js';
	import VariantChooser from '#lib/components/VariantChooser.svelte';
	import { money } from '#lib/format.js';
	import type { Product } from '#lib/server/types.js';

	let { product, campaign = null, chances = null }: { product: Product; campaign?: string | null; chances?: PublicChances | null } = $props();
	const variant = $derived(product.variants[0]);
	// Products with sizes or formats open a chooser (S4) so every card keeps one layout; the price shown is the lowest.
	const hasChoices = $derived(product.variants.length > 1);
	const fromPrice = $derived(Math.min(...product.variants.map((option) => option.priceMinor)));
	const samePrice = $derived(product.variants.every((option) => option.priceMinor === fromPrice));
	const anyInStock = $derived(product.variants.some((option) => option.inStock));
	const grants = $derived(cardChances(chances, product.variants.map((option) => option.id)));
	// Adding goes to the cart without a full page load; without JavaScript the form posts as usual.
	let adding = $state(false);
	let chooser = $state<ReturnType<typeof VariantChooser>>();
	let trigger = $state<HTMLButtonElement>();
</script>

<article class="card">
	<div class="media">
		<div class="art" aria-hidden="true">
			{#if product.imageUrl}
				<img src={product.imageUrl} alt="" loading="lazy" />
			{:else if product.kind === 'digital'}
				<svg viewBox="0 0 64 64"><path d="M16 6h22l12 12v40H16z" /><path d="M38 6v12h12M23 30h20M23 38h20M23 46h12" /></svg>
			{:else}
				<svg viewBox="0 0 64 64"><circle cx="32" cy="32" r="24" /><path d="M14 28h36v8H14z" /></svg>
			{/if}
		</div>
		{#if grants}
			<!-- Over the image, so a card with chances keeps the layout of one without (S3, S4). -->
			<div class="grants"><ChancesBadge count={grants.count} campaign={grants.campaign} lead={grants.upTo ? 'Hasta' : undefined} /></div>
		{/if}
	</div>
	<p class="kind">{product.kind === 'digital' ? 'Digital, descarga inmediata' : 'Producto físico'}</p>
	<h3>{product.name}</h3>
	<p class="description">{product.description}</p>
	{#if variant}
		<div class="buy">
			<span class="money price">{samePrice ? '' : 'Desde '}{money(fromPrice, variant.currency)}</span>
			{#if anyInStock && hasChoices}
				<!-- Without JavaScript the button opens the product page to choose there. -->
				<form
					method="GET"
					action="/tienda/{product.slug}"
					onsubmit={(event) => {
						event.preventDefault();
						chooser?.open();
					}}
				>
					{#if campaign}<input type="hidden" name="campaign" value={campaign} />{/if}
					<button class="button small" aria-haspopup="dialog" bind:this={trigger}>Agregar al carrito</button>
				</form>
				<VariantChooser bind:this={chooser} {product} {campaign} {chances} onclose={() => trigger?.focus()} />
			{:else if anyInStock}
				<form
					method="POST"
					action="/tienda?/add"
					use:enhance={() => {
						adding = true;
						return async ({ update }) => {
							await update();
							adding = false;
						};
					}}
				>
					<input type="hidden" name="variantId" value={variant.id} />
					{#if campaign}<input type="hidden" name="campaign" value={campaign} />{/if}
					<button class="button small" disabled={adding}>Agregar al carrito</button>
				</form>
			{:else}
				<span class="chip neutral">Sin stock</span>
			{/if}
		</div>
	{/if}
</article>

<style>
	.card {
		display: grid;
		grid-template-rows: auto auto auto 1fr auto;
		gap: 0.6rem;
		padding: 1.25rem;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--radius);
	}

	.art {
		display: grid;
		place-items: center;
		aspect-ratio: 16 / 10;
		margin-bottom: 0.4rem;
		border-radius: var(--radius-sm);
		background:
			repeating-linear-gradient(135deg, transparent 0 14px, color-mix(in srgb, var(--text) 5%, transparent) 14px 15px),
			var(--surface-2);
	}

	.art svg {
		width: 30%;
		fill: none;
		stroke: var(--text);
		stroke-width: 2.5;
		stroke-linejoin: round;
	}

	.art img {
		width: 100%;
		height: 100%;
		object-fit: cover;
		border-radius: inherit;
	}

	.kind {
		font-size: var(--step--1);
		color: var(--muted);
	}

	h3 {
		font-size: var(--step-2);
		text-transform: uppercase;
	}

	.description {
		color: var(--muted);
		font-size: var(--step--1);
	}

	/* Price above a full-width button on every card, so a longer price never
	   changes the layout of one card against the others. */
	.buy {
		display: grid;
		gap: 0.75rem;
		justify-items: start;
		margin-top: 0.6rem;
	}

	.buy form,
	.buy button {
		justify-self: stretch;
	}

	.buy form {
		display: grid;
		gap: 0.6rem;
	}

	.buy button {
		width: 100%;
		white-space: nowrap;
	}

	.price {
		font: 800 var(--step-2) / 1 var(--font-display);
	}

	.media {
		position: relative;
	}

	.grants {
		position: absolute;
		inset: auto 0.6rem 1rem;
		display: flex;
	}
</style>
