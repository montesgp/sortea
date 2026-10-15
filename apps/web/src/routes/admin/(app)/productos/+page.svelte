<script lang="ts">
	import { productKindLabel, productStatusLabel } from '#lib/catalog.js';
	import { money } from '#lib/format.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const list = $derived(data.list);
	const currency = $derived(data.session.organization.currency);
</script>

<svelte:head>
	<title>Productos | Panel</title>
</svelte:head>

<h1>Productos</h1>
<p class="muted small">Los productos no se borran: se archivan. Cambiar un precio afecta solo a las compras nuevas; cada pedido conserva el precio con el que se hizo.</p>

<div class="table-wrap">
	<table>
		<thead>
			<tr>
				<th scope="col">Producto</th>
				<th scope="col">Tipo</th>
				<th scope="col">Estado</th>
				<th scope="col">Variantes</th>
				<th scope="col" class="num">Desde</th>
				<th scope="col" class="num">Stock</th>
			</tr>
		</thead>
		<tbody>
			{#each list.products as product (product.id)}
				{@const status = productStatusLabel[product.status] ?? { label: product.status, tone: 'neutral' }}
				<tr>
					<td><a href="/admin/productos/{product.id}">{product.name}</a><br /><span class="muted small">/{product.slug}</span></td>
					<td>{productKindLabel[product.kind]}</td>
					<td><span class="chip {status.tone}">{status.label}</span></td>
					<td>{product.activeVariants} de {product.variants} activas</td>
					<td class="num money">{product.fromPriceMinor === null ? '—' : money(product.fromPriceMinor, currency)}</td>
					<td class="num">{product.stock === null ? 'Sin control' : product.stock}</td>
				</tr>
			{:else}
				<tr><td colspan="6" class="muted">Todavía no hay productos.</td></tr>
			{/each}
		</tbody>
	</table>
</div>

{#if list.canManage}
	<section class="panel" aria-labelledby="new-title">
		<h2 id="new-title">Nuevo producto</h2>
		<p class="muted small">Se crea como borrador. Después le agregás variantes con precio y lo ponés a la venta.</p>
		{#if form?.message}<p class="notice error" role="alert">{form.message}</p>{/if}
		<form method="POST" action="?/create" class="stack">
			<div class="row">
				<div class="field"><label for="name">Nombre</label><input id="name" name="name" required minlength="2" maxlength="120" defaultValue={form?.values?.name ?? ''} /></div>
				<div class="field">
					<label for="slug">Dirección en la tienda</label>
					<input id="slug" name="slug" required pattern="[a-z0-9]+(-[a-z0-9]+)*" placeholder="manual-tecnico" defaultValue={form?.values?.slug ?? ''} />
					<p class="hint">Minúsculas, números y guiones.</p>
				</div>
				<div class="field">
					<label for="kind">Tipo</label>
					<select id="kind" name="kind">
						<option value="digital" selected={form?.values?.kind !== 'physical'}>Digital (descarga)</option>
						<option value="physical" selected={form?.values?.kind === 'physical'}>Físico (envío o retiro)</option>
					</select>
				</div>
			</div>
			<div class="field"><label for="description">Descripción</label><textarea id="description" name="description" rows="3" required minlength="10" defaultValue={form?.values?.description ?? ''}></textarea></div>
			<button class="button small">Crear borrador</button>
		</form>
	</section>
{/if}

<style>
	h1 {
		font-size: var(--step-4);
		text-transform: uppercase;
		margin-bottom: 0.5rem;
	}

	h2 {
		font-size: var(--step-1);
		text-transform: uppercase;
	}

	.small {
		font-size: var(--step--1);
	}

	.table-wrap {
		overflow-x: auto;
		margin-block: 1rem;
		border: 1px solid var(--border);
		border-radius: var(--radius);
	}

	table {
		width: 100%;
		border-collapse: collapse;
		font-size: var(--step--1);
	}

	th,
	td {
		padding: 0.8rem 1rem;
		text-align: left;
		border-bottom: 1px solid var(--border);
		vertical-align: middle;
	}

	th {
		background: var(--surface);
		font-weight: 700;
		white-space: nowrap;
	}

	.num {
		text-align: right;
	}

	.panel,
	.stack {
		display: grid;
		gap: 0.9rem;
	}

	.row {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
		gap: 0.9rem;
	}
</style>
