<script lang="ts">
	import { dateTime } from '#lib/format.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const timezone = $derived(data.session.organization.timezone);
	const actor: Record<string, string> = { admin: 'Administración', platform_admin: 'Sysadmin (plataforma)', buyer: 'Comprador', system: 'Sistema', provider: 'Mercado Pago' };
	// A refused filter (a reversed date range) shows its message over an empty list.
	const result = $derived(data.result ?? { events: [], page: 1, pageSize: 50, total: 0, actions: [] });
	const pages = $derived(Math.max(1, Math.ceil(result.total / result.pageSize)));
	const filtered = $derived(['action', 'actor', 'target', 'from', 'to'].some((key) => data.filters[key]));
	const pageLink = (page: number) => {
		const params = new URLSearchParams();
		for (const key of ['action', 'actor', 'target', 'from', 'to']) if (data.filters[key]) params.set(key, data.filters[key]!);
		params.set('page', String(page));
		return `?${params}`;
	};
</script>

<svelte:head>
	<title>Auditoría | Panel</title>
</svelte:head>

<h1>Auditoría</h1>
<p class="muted small">El registro es de solo agregado: nadie puede editarlo ni borrarlo.</p>

<form class="filters" method="GET">
	<div class="field">
		<label for="action">Acción</label>
		<select id="action" name="action">
			<option value="">Todas</option>
			{#each result.actions as action (action)}
				<option value={action} selected={data.filters.action === action}>{action}</option>
			{/each}
		</select>
	</div>
	<div class="field">
		<label for="actor">Origen</label>
		<select id="actor" name="actor">
			<option value="">Todos</option>
			{#each Object.entries(actor) as [value, label] (value)}
				<option {value} selected={data.filters.actor === value}>{label}</option>
			{/each}
		</select>
	</div>
	<div class="field target">
		<label for="target">Id del objeto</label>
		<input id="target" name="target" maxlength="100" defaultValue={data.filters.target} placeholder="Id de pedido, campaña…" />
	</div>
	<!-- Whole days in the organization's time zone; the API checks the range. -->
	<div class="field">
		<label for="from">Desde</label>
		<input id="from" name="from" type="date" defaultValue={data.filters.from} />
	</div>
	<div class="field">
		<label for="to">Hasta</label>
		<input id="to" name="to" type="date" defaultValue={data.filters.to} />
	</div>
	<button class="button secondary">Filtrar</button>
	{#if filtered}<a class="button quiet" href="/admin/auditoria">Limpiar</a>{/if}
</form>

{#if data.error}<p class="notice error" role="alert">{data.error}</p>{/if}

<p class="muted small">{result.total} eventos.</p>

<div class="table-wrap">
	<table>
		<thead><tr><th scope="col">Fecha</th><th scope="col">Origen</th><th scope="col">Acción</th><th scope="col">Objeto</th><th scope="col">Detalle</th></tr></thead>
		<tbody>
			{#each result.events as event, index (index)}
				<tr>
					<td class="nowrap">{dateTime(event.createdAt, timezone, 'short')}</td>
					<td>{actor[event.actorType] ?? event.actorType}</td>
					<td><code>{event.action}</code></td>
					<td>{event.targetType}{#if event.targetId}<br /><a class="muted id" href={`?target=${encodeURIComponent(event.targetId)}`} title="Ver los eventos de este objeto">{event.targetId}</a>{/if}</td>
					<td class="meta">{Object.keys(event.metadata).length ? JSON.stringify(event.metadata) : ''}</td>
				</tr>
			{:else}
				<tr><td colspan="5" class="muted">No hay eventos con esos filtros.</td></tr>
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
		margin-bottom: 0.5rem;
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
		padding: 0.7rem 1rem;
		text-align: left;
		border-bottom: 1px solid var(--border);
		vertical-align: top;
	}

	th {
		background: var(--surface);
	}

	.filters {
		display: flex;
		flex-wrap: wrap;
		gap: 1rem;
		align-items: end;
		margin-top: 1rem;
	}

	.target {
		flex: 1 1 16rem;
		max-width: 24rem;
	}

	.id {
		font-family: ui-monospace, Consolas, monospace;
		font-size: 0.75rem;
		overflow-wrap: anywhere;
	}

	.pager {
		display: flex;
		gap: 1rem;
		align-items: center;
		margin-top: 1rem;
	}

	.nowrap {
		white-space: nowrap;
	}

	.meta {
		font-family: ui-monospace, Consolas, monospace;
		font-size: 0.75rem;
		color: var(--muted);
		max-width: 420px;
		overflow-wrap: anywhere;
	}
</style>
