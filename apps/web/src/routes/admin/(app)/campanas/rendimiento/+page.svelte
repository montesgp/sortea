<script lang="ts">
	import { campaignStatusChip, dateTime, money } from '#lib/format.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const comparison = $derived(data.comparison);
	const timezone = $derived(data.session.organization.timezone);
	const counts = new Intl.NumberFormat('es-AR');
	const count = (value: number) => counts.format(value);
	const cash = (minor: number) => money(minor, comparison.currency);
	const netUnknown = $derived(comparison.campaigns.reduce((total, campaign) => total + campaign.netUnknown, 0));

	type SortKey = 'opensAt' | 'purchases' | 'chances' | 'grossMinor';
	let sortKey = $state<SortKey>('opensAt');
	const sorted = $derived(
		sortKey === 'opensAt' ? comparison.campaigns : [...comparison.campaigns].sort((a, b) => b[sortKey as Exclude<SortKey, 'opensAt'>] - a[sortKey as Exclude<SortKey, 'opensAt'>])
	);
</script>

<svelte:head>
	<title>Rendimiento de las campañas | Panel</title>
</svelte:head>

<a class="small" href="/admin/campanas">Volver a campañas</a>
<header class="head">
	<h1>Rendimiento de las campañas</h1>
	<p class="muted small">
		Compras pagadas de cada campaña: las reintegradas o con contracargo no cuentan. «Con link» son las compras que llegaron por algún link de seguimiento; «Sin link», las demás.
		El neto es lo que informó Mercado Pago después de su comisión.{#if netUnknown}
			{' '}* {count(netUnknown)} compras todavía no tienen la comisión informada y no suman al neto.{/if}
	</p>
</header>

<div class="sort small">
	<label for="campaign-sort">Ordenar por</label>
	<select id="campaign-sort" bind:value={sortKey}>
		<option value="opensAt">Apertura</option>
		<option value="purchases">Compras</option>
		<option value="chances">Chances</option>
		<option value="grossMinor">Monto bruto</option>
	</select>
</div>

<div class="table-wrap">
	<table>
		<thead>
			<tr>
				<th scope="col">Campaña</th>
				<th scope="col">Estado</th>
				<th scope="col" class="num">Links</th>
				<th scope="col" class="num">Compras</th>
				<th scope="col" class="num">Personas</th>
				<th scope="col" class="num">Chances</th>
				<th scope="col" class="num">Bruto</th>
				<th scope="col" class="num">Neto</th>
				<th scope="col" class="num">Con link</th>
				<th scope="col" class="num">Sin link</th>
			</tr>
		</thead>
		<tbody>
			{#each sorted as campaign (campaign.id)}
				{@const status = campaignStatusChip(campaign)}
				<tr aria-label={campaign.title}>
					<th scope="row">
						<a href="/admin/campanas/{campaign.id}/links/rendimiento">{campaign.title}</a>
						<span class="muted small">{campaign.opensAt ? `Abre el ${dateTime(campaign.opensAt, campaign.timezone || timezone, 'short')}` : 'Apertura a definir'}</span>
					</th>
					<td><span class="chip {status.tone}">{status.label}</span></td>
					<td class="num">{count(campaign.links)}</td>
					<td class="num">{count(campaign.purchases)}</td>
					<td class="num">{count(campaign.buyers)}</td>
					<td class="num">{count(campaign.chances)}</td>
					<td class="num">{cash(campaign.grossMinor)}</td>
					<td class="num">{cash(campaign.netMinor)}{#if campaign.netUnknown}<span title="{campaign.netUnknown} compras sin comisión informada">*</span>{/if}</td>
					<td class="num">{count(campaign.withLink)}</td>
					<td class="num">{count(campaign.withoutLink)}</td>
				</tr>
			{:else}
				<tr><td colspan="10" class="muted">Todavía no hay campañas.</td></tr>
			{/each}
		</tbody>
	</table>
</div>

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

	.sort {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin-bottom: 0.75rem;
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

	thead th {
		background: var(--surface);
	}

	tbody th {
		font-weight: 400;
		white-space: normal;
		min-width: 12rem;
	}

	tbody th .muted {
		display: block;
	}

	.num {
		text-align: right;
		font-variant-numeric: tabular-nums;
	}
</style>
