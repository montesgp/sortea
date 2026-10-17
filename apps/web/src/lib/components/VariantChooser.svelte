<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import VariantFields from '#lib/components/VariantFields.svelte';
	import type { PublicChances } from '#lib/chances.js';
	import type { Product } from '#lib/server/types.js';

	/**
	 * Picks the option and quantity of a product with several variants without
	 * leaving the page (S4), so every product card keeps the same layout. The
	 * buyer can add several options in a row; the header count follows.
	 */
	let {
		product,
		campaign = null,
		chances = null,
		onclose
	}: { product: Product; campaign?: string | null; chances?: PublicChances | null; onclose?: () => void } = $props();

	let dialog: HTMLDialogElement;
	let selectedId = $state<string | undefined>();
	let quantity = $state(1);
	let busy = $state(false);
	let added = $state('');
	let refused = $state('');

	export function open() {
		selectedId ??= product.variants.find((option) => option.inStock)?.id;
		added = '';
		refused = '';
		dialog.showModal();
	}

	function close() {
		dialog.close();
	}
</script>

<dialog bind:this={dialog} class="chooser" aria-labelledby="chooser-{product.id}-title" onclose={() => onclose?.()}>
	<header>
		<h2 id="chooser-{product.id}-title">{product.name}</h2>
		<button type="button" class="close" aria-label="Cerrar" onclick={close}>
			<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
		</button>
	</header>
	<form
		method="POST"
		action="/tienda?/add"
		use:enhance={() => {
			busy = true;
			added = '';
			refused = '';
			const name = product.variants.find((option) => option.id === selectedId)?.name ?? product.name;
			const count = quantity;
			return async ({ result }) => {
				busy = false;
				if (result.type === 'redirect') {
					added = `Agregaste ${count} × ${name} al carrito.`;
					await invalidateAll();
				} else if (result.type === 'failure') {
					refused = typeof result.data?.message === 'string' ? result.data.message : 'No pudimos agregar ese producto';
				} else {
					refused = 'No pudimos agregar ese producto. Probá de nuevo.';
				}
			};
		}}
	>
		<VariantFields {product} {chances} idPrefix="chooser-{product.id}" bind:selectedId bind:quantity />
		{#if campaign}<input type="hidden" name="campaign" value={campaign} />{/if}
		<p class="feedback" role="status">{added}</p>
		{#if refused}<p class="notice error" role="alert">{refused}</p>{/if}
		<button class="button" disabled={busy || !selectedId}>Agregar</button>
	</form>
	<footer>
		<button type="button" class="button secondary" onclick={close}>Seguir comprando</button>
		<a class="button quiet" href="/carrito">Ir al carrito</a>
	</footer>
</dialog>

<style>
	.chooser {
		width: min(100% - 2rem, 32rem);
		max-height: calc(100dvh - 2rem);
		padding: 1.5rem;
		color: var(--text);
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		box-shadow: 0 24px 60px rgb(0 0 0 / 0.35);
	}

	.chooser::backdrop {
		background: rgb(0 0 0 / 0.55);
	}

	.chooser[open] {
		display: grid;
		gap: 1.25rem;
	}

	header {
		display: flex;
		align-items: start;
		justify-content: space-between;
		gap: 1rem;
	}

	h2 {
		font-size: var(--step-2);
		text-transform: uppercase;
	}

	.close {
		display: grid;
		place-items: center;
		flex: none;
		width: 44px;
		height: 44px;
		margin: -0.5rem -0.5rem 0 0;
		color: inherit;
		background: transparent;
		border: 0;
		border-radius: var(--radius-sm);
		cursor: pointer;
	}

	.close svg {
		width: 22px;
		fill: none;
		stroke: currentColor;
		stroke-width: 2.5;
		stroke-linecap: round;
	}

	form {
		display: grid;
		gap: 1rem;
	}

	.feedback:empty {
		display: none;
	}

	.feedback {
		font-weight: 700;
		color: var(--success, var(--accent));
	}

	footer {
		display: flex;
		flex-wrap: wrap;
		justify-content: space-between;
		gap: 0.75rem;
	}

	@media (prefers-reduced-motion: no-preference) {
		.chooser[open] {
			animation: rise 160ms ease-out;
		}

		@keyframes rise {
			from {
				opacity: 0;
				transform: translateY(12px);
			}
		}
	}
</style>
