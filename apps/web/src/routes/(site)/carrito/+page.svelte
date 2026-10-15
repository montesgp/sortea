<script lang="ts">
	import { onMount } from 'svelte';
	import { deserialize, enhance } from '$app/forms';
	import { goto, invalidateAll } from '$app/navigation';
	import { createCartSync } from '#lib/cart-sync.js';
	import { money } from '#lib/format.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const quote = $derived(data.quote);

	/*
	 * With JavaScript, a quantity is sent a moment after the buyer stops typing
	 * and the amounts follow at once; the server's quote then replaces them. The
	 * browser only previews unit price × quantity, it never decides a price
	 * (FR-COM-02). Without JavaScript the "Actualizar" button posts the form.
	 */
	let enhanced = $state(false);
	let drafts = $state<Record<string, number>>({});
	let syncError = $state('');
	const timers = new Map<string, ReturnType<typeof setTimeout>>();
	const DEBOUNCE_MS = 400;

	const sync = createCartSync({
		send: async (variantId, quantity) => {
			const body = new FormData();
			body.set('variantId', variantId);
			body.set('quantity', String(quantity));
			const response = await fetch('/carrito?/update', { method: 'POST', body, headers: { 'x-sveltekit-action': 'true' } });
			const result = deserialize(await response.text());
			return result.type === 'redirect' || result.type === 'success';
		},
		settle: async () => {
			try {
				await invalidateAll();
			} catch {
				syncError = 'No pudimos recalcular el total. Recargá la página.';
			} finally {
				for (const variantId of Object.keys(drafts)) {
					if (!timers.has(variantId) && !sync.pending(variantId)) delete drafts[variantId];
				}
			}
		},
		onError: () => (syncError = 'No pudimos actualizar la cantidad. Probá de nuevo.')
	});

	onMount(() => {
		enhanced = true;
		return () => timers.forEach(clearTimeout);
	});

	const limit = (variantId: string) => (data.limits as Record<string, number>)[variantId] ?? 20;
	const lines = $derived((quote?.lines ?? []).filter((line) => drafts[line.variantId] !== 0));
	const quantityOf = (line: { variantId: string; quantity: number }) => drafts[line.variantId] ?? line.quantity;
	const totalOf = (line: { variantId: string; quantity: number; unitPriceMinor: number; lineTotalMinor: number }) =>
		line.variantId in drafts ? line.unitPriceMinor * quantityOf(line) : line.lineTotalMinor;
	const updating = $derived(Object.keys(drafts).length > 0);
	const subtotal = $derived(updating ? lines.reduce((sum, line) => sum + totalOf(line), 0) : (quote?.subtotalMinor ?? 0));
	const units = $derived(lines.reduce((sum, line) => sum + quantityOf(line), 0));

	function commit(variantId: string, quantity: number) {
		clearTimeout(timers.get(variantId));
		timers.delete(variantId);
		syncError = '';
		sync.set(variantId, quantity);
	}

	/** Reads the input; returns null while it holds something that is not a quantity yet (empty, mid-typing). */
	function readQuantity(input: HTMLInputElement, variantId: string): number | null {
		if (input.value.trim() === '' || !Number.isFinite(input.valueAsNumber)) return null;
		const quantity = Math.max(0, Math.min(limit(variantId), Math.trunc(input.valueAsNumber)));
		if (String(quantity) !== input.value) input.value = String(quantity);
		return quantity;
	}

	function onQuantityInput(event: Event, variantId: string) {
		const quantity = readQuantity(event.currentTarget as HTMLInputElement, variantId);
		if (quantity === null) return;
		drafts[variantId] = quantity;
		clearTimeout(timers.get(variantId));
		timers.set(variantId, setTimeout(() => commit(variantId, quantity), DEBOUNCE_MS));
	}

	function onQuantitySubmit(event: SubmitEvent, variantId: string) {
		event.preventDefault();
		const input = (event.currentTarget as HTMLFormElement).elements.namedItem('quantity') as HTMLInputElement;
		const quantity = readQuantity(input, variantId);
		if (quantity === null) return;
		drafts[variantId] = quantity;
		commit(variantId, quantity);
	}

	function remove(event: SubmitEvent, variantId: string) {
		event.preventDefault();
		drafts[variantId] = 0;
		commit(variantId, 0);
	}

	/** Checkout prices the cart from the cookie, so it waits for the last change to land. */
	async function toCheckout(event: MouseEvent) {
		if (!updating) return;
		event.preventDefault();
		for (const variantId of [...timers.keys()]) if (variantId in drafts) commit(variantId, drafts[variantId]!);
		await sync.idle();
		await goto('/checkout');
	}

	let adding = $state('');
	const problems: Record<string, string> = {
		unknown_variant: 'Uno de los productos ya no existe.',
		inactive_variant: 'Uno de los productos ya no está a la venta.',
		insufficient_stock: 'No hay stock suficiente de uno de los productos.',
		over_max_per_order: 'Superaste la cantidad máxima por compra de un producto.',
		not_available_now: 'Uno de los productos no está disponible en este momento.'
	};
</script>

<svelte:head>
	<title>Carrito | {data.site?.organization.name}</title>
</svelte:head>

<section class="container page">
	<h1>Tu carrito</h1>

	{#if form?.message}<p class="notice error" role="alert">{form.message}</p>{/if}
	{#if syncError}<p class="notice error" role="alert">{syncError}</p>{/if}

	{#if data.empty}
		<div class="empty">
			<p class="muted">Todavía no agregaste productos.</p>
			<a class="button" href="/tienda">Ir a la tienda</a>
		</div>
	{:else if !quote}
		<p class="notice error">No pudimos calcular el total. Probá de nuevo en unos minutos.</p>
	{:else if !quote.ok}
		<div class="notice error" role="alert">
			{#each quote.errors ?? [] as problem (problem.code + (problem.variantId ?? ''))}
				<p>{problems[problem.code] ?? 'Hay un problema con tu carrito.'}</p>
			{/each}
			<a class="button small secondary" href="/tienda">Revisar productos</a>
		</div>
	{:else}
		<div class="layout">
			<div class="main">
				<section class="cart" aria-labelledby="cart-title">
					<div class="heading">
						<h2 id="cart-title">Productos en tu carrito</h2>
						<span class="muted small">{units} {units === 1 ? 'unidad' : 'unidades'}</span>
					</div>
					<ul class="lines">
						{#each lines as line (line.variantId)}
							<li>
								<div>
									<p class="name">{line.name}</p>
									<p class="muted small unit">{money(line.unitPriceMinor, quote.currency)} por unidad, {line.kind === 'digital' ? 'digital' : 'físico'}</p>
								</div>
								<form method="POST" action="?/update" class="qty" onsubmit={(event) => enhanced && onQuantitySubmit(event, line.variantId)}>
									<input type="hidden" name="variantId" value={line.variantId} />
									<label class="visually-hidden" for="qty-{line.variantId}">Cantidad de {line.name}</label>
									<input
										id="qty-{line.variantId}"
										name="quantity"
										type="number"
										min="0"
										max={limit(line.variantId)}
										defaultValue={line.quantity}
										inputmode="numeric"
										oninput={(event) => onQuantityInput(event, line.variantId)}
									/>
									{#if !enhanced}<button class="button small secondary">Actualizar</button>{/if}
								</form>
								<p class="money total" aria-busy={line.variantId in drafts}>{money(totalOf(line), quote.currency)}</p>
								<form method="POST" action="?/update" onsubmit={(event) => enhanced && remove(event, line.variantId)}>
									<input type="hidden" name="variantId" value={line.variantId} />
									<input type="hidden" name="quantity" value="0" />
									<button class="button quiet small" aria-label="Quitar {line.name}">Quitar</button>
								</form>
							</li>
						{/each}
					</ul>
				</section>

				{#if data.upsells.length}
					<section class="upsells" aria-labelledby="upsell-title">
						<p class="eyebrow">Sugerencias</p>
						<h2 id="upsell-title">¿Querés sumar algo?</h2>
						<p class="muted small">Opcional. Todavía no están en tu carrito: solo se suman si tocás Agregar.</p>
						<ul>
							{#each data.upsells as upsell (upsell.variantId)}
								<li>
									<div>
										<p class="name">{upsell.name}</p>
										{#if upsell.pitch}<p class="muted small">{upsell.pitch}</p>{/if}
									</div>
									<span class="money">+ {money(upsell.priceMinor, upsell.currency)}</span>
									<form
										method="POST"
										action="?/add"
										use:enhance={async () => {
											adding = upsell.variantId;
											await sync.idle();
											return async ({ result, update }) => {
												// The action answers with a redirect back here: refresh the data in place.
												if (result.type === 'redirect') await invalidateAll();
												else await update();
												adding = '';
											};
										}}
									>
										<input type="hidden" name="variantId" value={upsell.variantId} />
										<button class="button small secondary" disabled={adding === upsell.variantId} aria-label="Agregar {upsell.name}">Agregar</button>
									</form>
								</li>
							{/each}
						</ul>
					</section>
				{/if}
			</div>

			<aside class="panel summary" aria-label="Resumen" aria-busy={updating}>
				<dl>
					<div><dt>Subtotal</dt><dd class="money">{money(subtotal, quote.currency)}</dd></div>
					{#if quote.requiresDelivery}
						<div><dt>Entrega</dt><dd class="muted small">Se elige en el próximo paso</dd></div>
					{/if}
				</dl>
				<a class="button wide" href="/checkout" onclick={toCheckout}>Continuar con la compra</a>
				<p class="muted small" role="status">{updating ? 'Actualizando el total…' : 'El total final lo calcula el servidor con los precios vigentes.'}</p>
			</aside>
		</div>
	{/if}
</section>

<style>
	.page {
		padding-top: clamp(2.5rem, 2rem + 3vw, 5rem);
	}

	h1 {
		font-size: var(--step-4);
		text-transform: uppercase;
		margin-bottom: 2rem;
	}

	.empty {
		display: grid;
		gap: 1rem;
		justify-items: start;
	}

	.layout {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 340px;
		gap: 2rem;
		align-items: start;
	}

	ul {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.main {
		display: grid;
		gap: 2.5rem;
	}

	.heading {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 1rem;
		padding-bottom: 0.75rem;
		border-bottom: 2px solid var(--text);
	}

	.cart h2 {
		font-size: var(--step-1);
		text-transform: uppercase;
	}

	.lines li {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto auto auto;
		gap: 1rem;
		align-items: center;
		padding-block: 1.1rem;
		border-bottom: 1px solid var(--border);
	}

	.total[aria-busy='true'] {
		color: var(--muted);
	}

	/* Suggestions read as an aside: tinted, dashed and below the cart, never like a line already added. */
	.upsells {
		padding: clamp(1.1rem, 0.8rem + 1vw, 1.5rem);
		border: 1px dashed var(--border);
		border-radius: var(--radius);
		background: var(--surface-2);
	}

	.eyebrow {
		font-size: var(--step--1);
		font-weight: 700;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--muted);
	}

	.upsells ul {
		display: grid;
		gap: 0.75rem;
		margin-top: 1rem;
	}

	.upsells li {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto auto;
		gap: 1rem;
		align-items: center;
		padding: 0.85rem 1rem;
		border-radius: var(--radius-sm);
		background: var(--surface);
	}

	.name {
		font-weight: 700;
	}

	.small {
		font-size: var(--step--1);
	}

	.qty {
		display: flex;
		gap: 0.5rem;
		align-items: center;
	}

	.qty input {
		width: 4.5rem;
		min-height: 38px;
	}

	.total {
		font-weight: 700;
		min-width: 6rem;
		text-align: end;
	}

	.upsells h2 {
		font-size: var(--step-1);
		text-transform: uppercase;
		margin-top: 0.25rem;
	}

	.summary {
		position: sticky;
		top: 90px;
		display: grid;
		gap: 1rem;
	}

	dl {
		margin: 0;
		display: grid;
		gap: 0.5rem;
	}

	dl div {
		display: flex;
		justify-content: space-between;
		gap: 1rem;
	}

	dd {
		margin: 0;
		font-weight: 700;
	}

	.wide {
		width: 100%;
	}

	@media (max-width: 860px) {
		.layout {
			grid-template-columns: 1fr;
		}

		.lines li {
			grid-template-columns: 1fr auto;
		}

		.upsells li {
			grid-template-columns: 1fr auto;
		}

		.upsells li > div {
			grid-column: 1 / -1;
		}
	}
</style>
