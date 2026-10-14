<script lang="ts">
	import { money } from '#lib/format.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const quote = $derived(data.quote);
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
			<div>
				<ul class="lines">
					{#each quote.lines ?? [] as line (line.variantId)}
						<li>
							<div>
								<p class="name">{line.name}</p>
								<p class="muted small">{money(line.unitPriceMinor, quote.currency)} por unidad, {line.kind === 'digital' ? 'digital' : 'físico'}</p>
							</div>
							<form method="POST" action="?/update" class="qty">
								<input type="hidden" name="variantId" value={line.variantId} />
								<label class="visually-hidden" for="qty-{line.variantId}">Cantidad de {line.name}</label>
								<input id="qty-{line.variantId}" name="quantity" type="number" min="0" max="20" defaultValue={line.quantity} inputmode="numeric" />
								<button class="button small secondary">Actualizar</button>
							</form>
							<p class="money total">{money(line.lineTotalMinor, quote.currency)}</p>
							<form method="POST" action="?/update">
								<input type="hidden" name="variantId" value={line.variantId} />
								<input type="hidden" name="quantity" value="0" />
								<button class="button quiet small" aria-label="Quitar {line.name}">Quitar</button>
							</form>
						</li>
					{/each}
				</ul>

				{#if data.upsells.length}
					<section class="upsells" aria-labelledby="upsell-title">
						<h2 id="upsell-title">¿Querés sumar algo?</h2>
						<p class="muted small">Opcional. Solo se agrega si lo elegís.</p>
						<ul>
							{#each data.upsells as upsell (upsell.variantId)}
								<li>
									<div>
										<p class="name">{upsell.name}</p>
										{#if upsell.pitch}<p class="muted small">{upsell.pitch}</p>{/if}
									</div>
									<span class="money">+ {money(upsell.priceMinor, upsell.currency)}</span>
									<form method="POST" action="?/add">
										<input type="hidden" name="variantId" value={upsell.variantId} />
										<button class="button small secondary">Agregar</button>
									</form>
								</li>
							{/each}
						</ul>
					</section>
				{/if}
			</div>

			<aside class="panel summary" aria-label="Resumen">
				<dl>
					<div><dt>Subtotal</dt><dd class="money">{money(quote.subtotalMinor ?? 0, quote.currency)}</dd></div>
					{#if quote.requiresDelivery}
						<div><dt>Entrega</dt><dd class="muted small">Se elige en el próximo paso</dd></div>
					{/if}
				</dl>
				<a class="button wide" href="/checkout">Continuar con la compra</a>
				<p class="muted small">El total final lo calcula el servidor con los precios vigentes.</p>
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

	.lines li,
	.upsells li {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto auto auto;
		gap: 1rem;
		align-items: center;
		padding-block: 1.1rem;
		border-bottom: 1px solid var(--border);
	}

	.upsells li {
		grid-template-columns: minmax(0, 1fr) auto auto;
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

	.upsells {
		margin-top: 2.5rem;
	}

	.upsells h2 {
		font-size: var(--step-2);
		text-transform: uppercase;
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
	}
</style>
