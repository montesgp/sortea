<script lang="ts">
	import TextArea from '#lib/components/TextArea.svelte';
	import { productKindLabel, productStatusLabel } from '#lib/catalog.js';
	import { money } from '#lib/format.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const list = $derived(data.list);
	const currency = $derived(data.session.organization.currency);
	const here = $derived(data.archived ? '?vista=archivados' : '/admin/productos');
	// Keeps the tab when a form posts: `?vista=archivados&/remove`.
	const action = (name: string) => (data.archived ? `?vista=archivados&/${name}` : `?/${name}`);
	const confirm = $derived(form?.action === 'confirm' && 'confirm' in form ? form.confirm : null);
	const feedback = $derived(form?.action === 'remove' && 'message' in form ? form : null);
</script>

<svelte:head>
	<title>Productos | Panel</title>
</svelte:head>

<h1>Productos</h1>
<p class="muted small">
	Un producto sin pedidos se puede eliminar; uno con pedidos se archiva, para que sus compradores conserven comprobantes y descargas. Cambiar un precio afecta solo a las
	compras nuevas; cada pedido conserva el precio con el que se hizo.
</p>

<nav class="tabs" aria-label="Vistas de productos">
	<a href="/admin/productos" aria-current={data.archived ? undefined : 'page'}>Productos</a>
	<a href="?vista=archivados" aria-current={data.archived ? 'page' : undefined}>Archivados ({list.archivedCount})</a>
</nav>

{#if feedback}<p class="notice {feedback.ok ? 'ok' : 'error'}" role={feedback.ok ? 'status' : 'alert'}>{feedback.message}</p>{/if}

{#if confirm}
	<!-- Second step of "Eliminar" (S10): the server already said what will happen; nothing changed yet. -->
	<section class="panel confirm" aria-labelledby="confirm-title">
		<h2 id="confirm-title">
			{confirm.outcome === 'refuse' ? `No se puede eliminar ${confirm.product.name}` : confirm.outcome === 'delete' ? `¿Eliminar ${confirm.product.name}?` : `¿Archivar ${confirm.product.name}?`}
		</h2>
		<p>{confirm.message}</p>
		{#if confirm.outcome === 'refuse' && confirm.campaigns?.length}
			<ul>
				{#each confirm.campaigns as campaign (campaign.id)}
					<li><a href="/admin/campanas/{campaign.id}">{campaign.title}</a></li>
				{/each}
			</ul>
		{/if}
		<div class="actions">
			{#if confirm.outcome === 'delete' || (confirm.outcome === 'archive' && confirm.product.status !== 'archived')}
				<form method="POST" action={action('remove')}>
					<input type="hidden" name="id" value={confirm.product.id} />
					<button class="button small {confirm.outcome === 'delete' ? 'danger' : ''}">{confirm.outcome === 'delete' ? 'Eliminar definitivamente' : 'Archivar'}</button>
				</form>
				<a class="button small secondary" href={here}>Cancelar</a>
			{:else}
				<a class="button small secondary" href={here}>Volver</a>
			{/if}
		</div>
	</section>
{/if}

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
				{#if list.canManage}<th scope="col"><span class="visually-hidden">Acciones</span></th>{/if}
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
					{#if list.canManage}
						<td class="row-actions">
							{#if product.status === 'archived'}
								<form method="POST" action={action('restore')}>
									<input type="hidden" name="id" value={product.id} />
									<button class="link" aria-label="Restaurar {product.name}">Restaurar</button>
								</form>
							{/if}
							<form method="POST" action={action('confirmRemove')}>
								<input type="hidden" name="id" value={product.id} />
								<button class="link danger" aria-label="Eliminar {product.name}">Eliminar</button>
							</form>
						</td>
					{/if}
				</tr>
			{:else}
				<tr><td colspan={list.canManage ? 7 : 6} class="muted">{data.archived ? 'No hay productos archivados.' : 'Todavía no hay productos.'}</td></tr>
			{/each}
		</tbody>
	</table>
</div>

{#if list.canManage && !data.archived}
	<section class="panel" aria-labelledby="new-title">
		<h2 id="new-title">Nuevo producto</h2>
		<p class="muted small">Se crea como borrador. Después le agregás variantes con precio y lo ponés a la venta.</p>
		<!-- Only the create form's own refusal: removals and confirmations report above the list. -->
		{#if form?.message && !form.ok && !('action' in form)}<p class="notice error" role="alert">{form.message}</p>{/if}
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
			<div class="field"><label for="description">Descripción</label><TextArea id="description" name="description" rows={3} required minlength={10} value={form?.values?.description ?? ''} /></div>
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

	.tabs {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
		margin-block: 1rem;
	}

	.tabs a {
		padding: 0.45rem 0.8rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		text-decoration: none;
		font-weight: 600;
		font-size: var(--step--1);
	}

	.tabs a[aria-current='page'] {
		background: var(--text);
		color: var(--bg);
		border-color: var(--text);
	}

	.confirm {
		border-left: 4px solid var(--danger);
		margin-bottom: 1rem;
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.6rem;
		align-items: center;
	}

	.button.danger {
		--button-bg: var(--danger);
		--button-fg: #fff;
	}

	.row-actions {
		white-space: nowrap;
		text-align: right;
	}

	.row-actions form {
		display: inline;
	}

	.row-actions form + form {
		margin-left: 0.9rem;
	}

	.link {
		background: none;
		border: 0;
		padding: 0;
		font: inherit;
		color: inherit;
		text-decoration: underline;
		text-underline-offset: 0.2em;
		cursor: pointer;
	}

	.link.danger {
		color: var(--danger);
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
