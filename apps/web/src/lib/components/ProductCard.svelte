<script lang="ts">
	import { money } from '#lib/format.js';
	import type { Product } from '#lib/server/types.js';

	let { product, campaign = null }: { product: Product; campaign?: string | null } = $props();
	const variant = $derived(product.variants[0]);
</script>

<article class="card">
	<div class="art" aria-hidden="true">
		{#if product.imageUrl}
			<img src={product.imageUrl} alt="" loading="lazy" />
		{:else if product.kind === 'digital'}
			<svg viewBox="0 0 64 64"><path d="M16 6h22l12 12v40H16z" /><path d="M38 6v12h12M23 30h20M23 38h20M23 46h12" /></svg>
		{:else}
			<svg viewBox="0 0 64 64"><circle cx="32" cy="32" r="24" /><path d="M14 28h36v8H14z" /></svg>
		{/if}
	</div>
	<p class="kind">{product.kind === 'digital' ? 'Digital, descarga inmediata' : 'Producto físico'}</p>
	<h3>{product.name}</h3>
	<p class="description">{product.description}</p>
	{#if variant}
		<div class="buy">
			<span class="money price">{money(variant.priceMinor, variant.currency)}</span>
			{#if variant.inStock}
				<form method="POST" action="/tienda?/add">
					<input type="hidden" name="variantId" value={variant.id} />
					{#if campaign}<input type="hidden" name="campaign" value={campaign} />{/if}
					<button class="button small">Agregar al carrito</button>
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

	.buy {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem 1rem;
		margin-top: 0.6rem;
	}

	.buy form {
		flex: 1 0 auto;
		display: flex;
		justify-content: flex-end;
	}

	.buy button {
		white-space: nowrap;
	}

	.price {
		font: 800 var(--step-2) / 1 var(--font-display);
	}
</style>
