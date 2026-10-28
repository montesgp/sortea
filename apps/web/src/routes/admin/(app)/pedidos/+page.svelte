<script lang="ts">
	import { dateTime, money, orderStatusLabel } from '#lib/format.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const result = $derived(data.result);
	const timezone = $derived(data.session.organization.timezone);
	// Name and email only match for staff who can see personal data (orders.pii, ADR 0010).
	const buyerSearch = $derived(data.session.permissions.includes('orders.pii'));
	const pages = $derived(Math.max(1, Math.ceil(result.total / result.pageSize)));
	const pageLink = (page: number) => {
		const params = new URLSearchParams();
		if (data.filters.status) params.set('status', data.filters.status);
		if (data.filters.q) params.set('q', data.filters.q);
		params.set('page', String(page));
		return `?${params}`;
	};
</script>

<svelte:head>
	<title>Pedidos | Panel</title>
</svelte:head>

<h1>Pedidos</h1>

<form class="filters" method="GET">
	<div class="field">
		<label for="q">{buyerSearch ? 'Comprobante, nombre o email' : 'Comprobante'}</label>
		<input id="q" name="q" maxlength="40" defaultValue={data.filters.q} placeholder={buyerSearch ? 'Comprobante, Ana Pérez o ana@…' : 'Comprobante'} />
	</div>
	<div class="field">
		<label for="status">Estado</label>
		<select id="status" name="status">
			<option value="">Todos</option>
			{#each Object.entries(orderStatusLabel) as [value, info] (value)}
				<option {value} selected={data.filters.status === value}>{info.label}</option>
			{/each}
		</select>
	</div>
	<button class="button secondary">Filtrar</button>
</form>

<p class="muted small">{result.total} pedidos. Los datos de contacto se muestran enmascarados.</p>

<div class="table-wrap">
	<table>
		<thead>
			<tr>
				<th scope="col">Comprobante</th>
				<th scope="col">Comprador</th>
				<th scope="col">Estado</th>
				<th scope="col">Entrega</th>
				<th scope="col" class="num">Total</th>
				<th scope="col">Creado</th>
			</tr>
		</thead>
		<tbody>
			{#each result.orders as order (order.id)}
				{@const status = orderStatusLabel[order.status] ?? { label: order.status, tone: 'neutral' }}
				<tr>
					<td><a href="/admin/pedidos/{order.id}">{order.reference}</a></td>
					<td>{order.buyer}<br /><span class="muted small">{order.email}{order.province ? ` · ${order.province}` : ''}</span></td>
					<td><span class="chip {status.tone}">{status.label}</span></td>
					<td>{{ digital: 'Digital', pickup: 'Retiro', shipping: 'Envío' }[order.deliveryMethod]}</td>
					<td class="num money">{money(order.totalMinor, order.currency)}</td>
					<td class="small">{dateTime(order.createdAt, timezone, 'short')}</td>
				</tr>
			{:else}
				<tr><td colspan="6" class="muted">No hay pedidos con esos filtros.</td></tr>
			{/each}
		</tbody>
	</table>
</div>

{#if pages > 1}
	<nav class="pager" aria-label="Páginas">
		{#if result.page > 1}<a class="button secondary small" href={pageLink(result.page - 1)}>Anterior</a>{/if}
		<span class="muted small">Página {result.page} de {pages}</span>
		{#if result.page < pages}<a class="button secondary small" href={pageLink(result.page + 1)}>Siguiente</a>{/if}
	</nav>
{/if}

<style>
	h1 {
		font-size: var(--step-4);
		text-transform: uppercase;
		margin-bottom: 1.5rem;
	}

	.filters {
		display: flex;
		flex-wrap: wrap;
		gap: 1rem;
		align-items: end;
		margin-bottom: 1rem;
	}

	.small {
		font-size: var(--step--1);
	}

	.table-wrap {
		overflow-x: auto;
		margin-top: 1rem;
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

	.pager {
		display: flex;
		gap: 1rem;
		align-items: center;
		margin-top: 1rem;
	}
</style>
