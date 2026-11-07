<script lang="ts">
	import { money } from '#lib/format.js';
	import { trackingChannelLabel } from '#lib/tracking.js';
	import type { PageProps } from './$types';
	import type { PerformanceBlock } from './+page.server';

	let { data }: PageProps = $props();
	const report = $derived(data.report);
	const can = (permission: string) => data.session.permissions.includes(permission);
	const counts = new Intl.NumberFormat('es-AR');
	const count = (value: number) => counts.format(value);
	const cash = (minor: number) => money(minor, report.currency);
	const channelName = (channel: string | null) => (channel === null ? 'sin dato de la red' : (trackingChannelLabel[channel as keyof typeof trackingChannelLabel] ?? channel));

	type SortKey = 'purchases' | 'chances' | 'grossMinor';
	type SortBlock = 'participated' | 'last';
	let sortKey = $state<SortKey>('purchases');
	let sortBlock = $state<SortBlock>('participated');
	const sorted = $derived([...report.links].sort((a, b) => b[sortBlock][sortKey] - a[sortBlock][sortKey]));
</script>

<svelte:head>
	<title>Rendimiento de los links | {report.campaign.title}</title>
</svelte:head>

{#snippet blockCells(block: PerformanceBlock)}
	<td class="num">{count(block.purchases)}</td>
	<td class="num">{count(block.buyers)}</td>
	<td class="num">{count(block.chances)}</td>
	<td class="num">{cash(block.grossMinor)}</td>
	<td class="num">{cash(block.netMinor)}{#if block.netUnknown}<span title="{block.netUnknown} compras sin comisión informada">*</span>{/if}</td>
{/snippet}

{#snippet emptyCells()}
	<td class="num muted" colspan="5">—</td>
{/snippet}

{#snippet blockHeads()}
	<th scope="col" class="num">Compras</th>
	<th scope="col" class="num">Personas</th>
	<th scope="col" class="num">Chances</th>
	<th scope="col" class="num">Bruto</th>
	<th scope="col" class="num">Neto</th>
{/snippet}

<a class="small" href="/admin/campanas/{report.campaign.id}">Volver a {report.campaign.title}</a>
<header class="head">
	<h1>Rendimiento de los links</h1>
	<nav class="tabs small" aria-label="Links de seguimiento">
		{#if can('campaigns.manage')}<a href="/admin/campanas/{report.campaign.id}/links">Links</a>{/if}
		<a href="/admin/campanas/{report.campaign.id}/links/rendimiento" aria-current="page">Rendimiento</a>
		<a href="/admin/campanas/rendimiento">Comparar campañas</a>
	</nav>
	<p class="muted small">
		Solo cuentan las compras pagadas: las reintegradas o con contracargo dejan de sumar. «Participó» suma cada compra en la que la persona pasó por ese video, aunque después
		entrara por otro. «Último» suma la compra solo al último video por el que entró, así que «Último» más «Sin link» da el total de la campaña.
	</p>
	<p class="muted small">
		El neto es lo que informó Mercado Pago después de su comisión.{#if report.total.netUnknown}
			{' '}* {count(report.total.netUnknown)} compras todavía no tienen la comisión informada y no suman al neto.{/if} Personas no se suma entre filas: alguien puede comprar
		por más de un video.
	</p>
</header>

<section class="panel" aria-labelledby="videos-title">
	<div class="title-row">
		<h2 id="videos-title">Por video</h2>
		<div class="sort small">
			<label for="sort-key">Ordenar por</label>
			<select id="sort-key" bind:value={sortKey}>
				<option value="purchases">Compras</option>
				<option value="chances">Chances</option>
				<option value="grossMinor">Monto bruto</option>
			</select>
			<label for="sort-block">según</label>
			<select id="sort-block" bind:value={sortBlock}>
				<option value="participated">Participó</option>
				<option value="last">Último</option>
			</select>
		</div>
	</div>
	<div class="table-wrap">
		<table>
			<thead>
				<tr>
					<th scope="col" rowspan="2">Video</th>
					<th scope="colgroup" colspan="5" class="group">Participó</th>
					<th scope="colgroup" colspan="5" class="group">Último</th>
				</tr>
				<tr>{@render blockHeads()}{@render blockHeads()}</tr>
			</thead>
			<tbody>
				{#each sorted as link (link.id)}
					<tr aria-label={link.name}>
						<th scope="row">
							<span class="name">
								<strong>{link.name}</strong>
								<span class="chip neutral">{channelName(link.channel)}</span>
								{#if link.archivedAt}<span class="chip neutral">Archivado</span>{/if}
							</span>
							{#if link.otherCampaign}<span class="muted small">Link de {link.otherCampaign.title}</span>{/if}
						</th>
						{@render blockCells(link.participated)}
						{@render blockCells(link.last)}
					</tr>
				{:else}
					<tr><td colspan="11" class="muted">Todavía no hay links para esta campaña.</td></tr>
				{/each}
				{#each report.withoutLink as row (row.channel ?? 'none')}
					<tr aria-label="Sin link · {channelName(row.channel)}">
						<th scope="row">Sin link · {channelName(row.channel)}</th>
						{@render emptyCells()}
						{@render blockCells(row)}
					</tr>
				{/each}
			</tbody>
			<tfoot>
				<tr aria-label="Total de la campaña">
					<th scope="row">Total de la campaña</th>
					{@render emptyCells()}
					{@render blockCells(report.total)}
				</tr>
			</tfoot>
		</table>
	</div>
</section>

<section class="panel" aria-labelledby="channels-title">
	<h2 id="channels-title">Por red</h2>
	<p class="muted small">Cada red suma el «último» de sus videos y las compras sin link que llegaron desde esa red.</p>
	<div class="table-wrap">
		<table>
			<thead>
				<tr><th scope="col">Red</th>{@render blockHeads()}</tr>
			</thead>
			<tbody>
				{#each report.channels as row (row.channel ?? 'none')}
					<tr aria-label={row.channel === null ? 'Sin dato de la red' : channelName(row.channel)}>
						<th scope="row">{row.channel === null ? 'Sin dato de la red' : channelName(row.channel)}</th>
						{@render blockCells(row)}
					</tr>
				{:else}
					<tr><td colspan="6" class="muted">Todavía no hay compras pagadas en esta campaña.</td></tr>
				{/each}
			</tbody>
			<tfoot>
				<tr>
					<th scope="row">Total de la campaña</th>
					{@render blockCells(report.total)}
				</tr>
			</tfoot>
		</table>
	</div>
</section>

<style>
	.head {
		margin: 0.75rem 0 1.25rem;
		display: grid;
		gap: 0.5rem;
	}

	h1 {
		font-size: var(--step-4);
		text-transform: uppercase;
	}

	h2 {
		font-size: var(--step-1);
		text-transform: uppercase;
	}

	.tabs {
		display: flex;
		flex-wrap: wrap;
		gap: 1rem;
	}

	.tabs [aria-current='page'] {
		font-weight: 700;
		text-decoration: none;
	}

	.panel {
		margin-block: 1rem;
		display: grid;
		gap: 0.75rem;
	}

	.title-row {
		display: flex;
		flex-wrap: wrap;
		justify-content: space-between;
		align-items: center;
		gap: 0.75rem;
	}

	.sort {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem;
	}

	.sort select {
		width: auto;
	}

	.table-wrap {
		overflow-x: auto;
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
		padding: 0.6rem 0.8rem;
		text-align: left;
		border-bottom: 1px solid var(--border);
		white-space: nowrap;
	}

	thead th,
	tfoot th,
	tfoot td {
		background: var(--surface);
	}

	tbody th {
		font-weight: 400;
		white-space: normal;
		min-width: 12rem;
	}

	.group {
		text-align: center;
	}

	.num {
		text-align: right;
		font-variant-numeric: tabular-nums;
	}

	.name {
		display: inline-flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.3rem 0.5rem;
	}

	th .muted {
		display: block;
	}
</style>
