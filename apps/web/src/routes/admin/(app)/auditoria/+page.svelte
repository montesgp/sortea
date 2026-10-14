<script lang="ts">
	import { dateTime } from '#lib/format.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const timezone = $derived(data.session.organization.timezone);
	const actor: Record<string, string> = { admin: 'Administración', platform_admin: 'Plataforma', buyer: 'Comprador', system: 'Sistema', provider: 'Mercado Pago' };
</script>

<svelte:head>
	<title>Auditoría | Panel</title>
</svelte:head>

<h1>Auditoría</h1>
<p class="muted small">Últimos 100 eventos. El registro es de solo agregado: nadie puede editarlo ni borrarlo.</p>

<div class="table-wrap">
	<table>
		<thead><tr><th scope="col">Fecha</th><th scope="col">Origen</th><th scope="col">Acción</th><th scope="col">Objeto</th><th scope="col">Detalle</th></tr></thead>
		<tbody>
			{#each data.events as event, index (index)}
				<tr>
					<td class="nowrap">{dateTime(event.createdAt, timezone, 'short')}</td>
					<td>{actor[event.actorType] ?? event.actorType}</td>
					<td><code>{event.action}</code></td>
					<td>{event.targetType}</td>
					<td class="meta">{Object.keys(event.metadata).length ? JSON.stringify(event.metadata) : ''}</td>
				</tr>
			{/each}
		</tbody>
	</table>
</div>

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
