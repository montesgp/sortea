<script lang="ts">
	import { campaignStatusLabel, dateOnly } from '#lib/format.js';
	import type { CampaignSummary } from '#lib/server/types.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const timezone = $derived(data.site?.organization.timezone ?? 'America/Argentina/Buenos_Aires');
</script>

<svelte:head>
	<title>Campañas | {data.site?.organization.name}</title>
	<meta name="description" content="Campañas, premios, bases y transparencia de {data.site?.organization.name}." />
</svelte:head>

{#snippet list(campaigns: CampaignSummary[])}
	<ul class="list">
		{#each campaigns as campaign (campaign.slug)}
			{@const status = campaignStatusLabel[campaign.status] ?? { label: campaign.status, tone: 'neutral' }}
			<li>
				<a href="/sorteos/{campaign.slug}">
					<div class="chips">
						<span class="chip {status.tone}">{status.label}</span>
						{#if campaign.isDemo}<span class="chip neutral">Demostración</span>{/if}
					</div>
					<h3>{campaign.title}</h3>
					<p class="muted">{campaign.prizeCount} premios. Cierra el {dateOnly(campaign.closesAt, timezone)}.</p>
				</a>
			</li>
		{/each}
	</ul>
{/snippet}

<section class="container page">
	<h1>Campañas</h1>
	<p class="muted lead">Cada campaña publica sus premios, fechas, bases y el registro que permite verificarla.</p>

	{#if data.unavailable}
		<p class="notice error">No pudimos cargar las campañas. Probá de nuevo en unos minutos.</p>
	{/if}

	<h2>En curso y próximas</h2>
	{#if data.active.length}
		{@render list(data.active)}
	{:else}
		<p class="muted">No hay campañas en curso.</p>
	{/if}

	{#if data.past.length}
		<h2>Anteriores</h2>
		{@render list(data.past)}
	{/if}
</section>

<style>
	.page {
		padding-top: clamp(2.5rem, 2rem + 3vw, 5rem);
	}

	h1 {
		font-size: var(--step-5);
		text-transform: uppercase;
	}

	.lead {
		margin: 1rem 0 3rem;
		max-width: 60ch;
		font-size: var(--step-1);
	}

	h2 {
		font-size: var(--step-2);
		text-transform: uppercase;
		margin: 2.5rem 0 1rem;
	}

	.list {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.list a {
		display: grid;
		gap: 0.5rem;
		padding-block: 1.5rem;
		border-top: 1px solid var(--border);
		text-decoration: none;
	}

	.list li:last-child a {
		border-bottom: 1px solid var(--border);
	}

	.list a:hover h3 {
		color: var(--accent);
	}

	.chips {
		display: flex;
		gap: 0.5rem;
	}

	h3 {
		font-size: var(--step-4);
		text-transform: uppercase;
		transition: color 160ms;
	}
</style>
