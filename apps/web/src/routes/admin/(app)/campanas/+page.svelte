<script lang="ts">
	import { campaignDate, campaignStatusChip } from '#lib/format.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const timezone = $derived(data.session.organization.timezone);
</script>

<svelte:head>
	<title>Campañas | Panel</title>
</svelte:head>

<header class="head">
	<h1>Campañas</h1>
	<div class="links">
		{#if data.session.permissions.includes('dashboard.view')}<a class="small" href="/admin/campanas/rendimiento">Comparar rendimiento de campañas</a>{/if}
		<!-- S5 (owner feedback 2026-11-10): roles that manage campaigns, platform admins included, create them here. -->
		{#if data.session.permissions.includes('campaigns.manage')}<a class="button small" href="/admin/campanas/nueva">Nueva campaña</a>{/if}
	</div>
</header>

<div class="table-wrap">
	<table>
		<thead>
			<tr><th scope="col">Campaña</th><th scope="col">Estado</th><th scope="col">Apertura</th><th scope="col">Cierre</th><th scope="col" class="num">Participaciones</th></tr>
		</thead>
		<tbody>
			{#each data.campaigns as campaign (campaign.id)}
				{@const status = campaignStatusChip(campaign)}
				<tr>
					<td><span class="name"><a href="/admin/campanas/{campaign.id}">{campaign.title}</a>{#if campaign.isDemo}<span class="chip neutral">Demo</span>{/if}</span></td>
					<td><span class="chip {status.tone}">{status.label}</span></td>
					<td>{campaignDate(campaign.opensAt, timezone)}</td>
					<td>{campaignDate(campaign.closesAt, timezone)}</td>
					<td class="num">{campaign.entries}</td>
				</tr>
			{:else}
				<tr><td colspan="5" class="muted">Todavía no hay campañas.</td></tr>
			{/each}
		</tbody>
	</table>
</div>

<style>
	.head {
		display: flex;
		flex-wrap: wrap;
		justify-content: space-between;
		align-items: baseline;
		gap: 0.5rem 1rem;
		margin-bottom: 1.5rem;
	}

	h1 {
		font-size: var(--step-4);
		text-transform: uppercase;
	}

	.links {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem 1rem;
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
		padding: 0.8rem 1rem;
		text-align: left;
		border-bottom: 1px solid var(--border);
	}

	th {
		background: var(--surface);
	}

	.num {
		text-align: right;
	}

	/* The Demo pill sits beside the name, or below it when the name wraps. */
	.name {
		display: inline-flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.4rem 0.6rem;
	}
</style>
