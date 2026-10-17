<script lang="ts">
	import { lineLimit } from '#lib/cart-add.js';
	import type { PublicChances } from '#lib/chances.js';
	import ChancesBadge from '#lib/components/ChancesBadge.svelte';
	import { money } from '#lib/format.js';
	import type { Product } from '#lib/server/types.js';

	/**
	 * The option and quantity a buyer picks for one product (S4), shared by the
	 * shop's chooser and the product page. The total is a preview: the cart
	 * quote from the API decides the amounts.
	 */
	let {
		product,
		idPrefix,
		chances = null,
		selectedId = $bindable(),
		quantity = $bindable(1)
	}: { product: Product; idPrefix: string; chances?: PublicChances | null; selectedId?: string; quantity?: number } = $props();

	const samePrice = $derived(product.variants.every((option) => option.priceMinor === product.variants[0]?.priceMinor));
	const selected = $derived(product.variants.find((option) => option.id === selectedId));
	const limit = $derived(lineLimit(selected?.maxPerOrder));
	const validQuantity = $derived(Number.isInteger(quantity) && quantity >= 1 && quantity <= limit);
	// What this choice earns with the locked rules (S3); the cart shows the count the API confirms.
	const earned = $derived(chances && selectedId && validQuantity ? (chances.perUnit[selectedId] ?? 0) * quantity : 0);

	function choose(id: string) {
		selectedId = id;
		const next = product.variants.find((option) => option.id === id);
		if (next && quantity > lineLimit(next.maxPerOrder)) quantity = lineLimit(next.maxPerOrder);
	}
</script>

<fieldset class="options">
	<legend class="label">Opción</legend>
	<div class="choices">
		{#each product.variants as option (option.id)}
			<label class="choice" class:off={!option.inStock}>
				<input
					type="radio"
					name="variantId"
					value={option.id}
					checked={option.id === selectedId}
					disabled={!option.inStock}
					required
					onchange={() => choose(option.id)}
				/>
				<span>{option.name}</span>
				{#if !samePrice}<span class="money small">{money(option.priceMinor, option.currency)}</span>{/if}
				{#if !option.inStock}<span class="small">Sin stock</span>{/if}
			</label>
		{/each}
	</div>
</fieldset>

<div class="row">
	<div class="field quantity">
		<label class="label" for="{idPrefix}-quantity">Cantidad</label>
		<input id="{idPrefix}-quantity" type="number" name="quantity" inputmode="numeric" min="1" max={limit} step="1" required bind:value={quantity} />
		<span class="hint">Hasta {limit} por compra.</span>
	</div>
	{#if selected}
		<div class="amounts">
			<p class="unit money">{money(selected.priceMinor, selected.currency)} c/u</p>
			{#if validQuantity}<p class="preview money">Total: {money(selected.priceMinor * quantity, selected.currency)}</p>{/if}
		</div>
	{/if}
</div>

{#if chances && earned > 0}
	<ChancesBadge count={earned} campaign={chances.campaign.title} lead="Sumás" size="line" />
{/if}

<style>
	.options {
		display: grid;
		gap: 0.5rem;
		margin: 0;
		padding: 0;
		border: 0;
		min-width: 0;
	}

	.label {
		font-weight: 600;
		font-size: var(--step--1);
	}

	.choices {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}

	/* Each option is a large pill: the whole pill is the hit area. */
	.choice {
		position: relative;
		display: inline-grid;
		justify-items: center;
		min-width: 4.5rem;
		min-height: 48px;
		align-content: center;
		padding: 0.4rem 0.9rem;
		border: 2px solid var(--border);
		border-radius: var(--radius-sm);
		background: var(--surface);
		font-weight: 700;
		cursor: pointer;
	}

	.choice input {
		position: absolute;
		inset: 0;
		opacity: 0;
		margin: 0;
		cursor: inherit;
	}

	.choice:has(input:checked) {
		color: var(--accent-text);
		border-color: var(--accent);
		background: var(--accent);
	}

	.choice:has(input:focus-visible) {
		box-shadow: var(--focus);
	}

	.choice.off {
		opacity: 0.5;
		cursor: not-allowed;
		text-decoration: line-through;
	}

	.small {
		font-size: var(--step--1);
		font-weight: 500;
	}

	.row {
		display: flex;
		flex-wrap: wrap;
		align-items: end;
		justify-content: space-between;
		gap: 1rem;
	}

	.quantity input {
		width: 7rem;
	}

	.amounts {
		display: grid;
		justify-items: end;
		gap: 0.15rem;
	}

	.unit {
		color: var(--muted);
		font-size: var(--step--1);
	}

	.preview {
		font: 800 var(--step-1) / 1.1 var(--font-display);
	}
</style>
