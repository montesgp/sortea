<script lang="ts">
	import { campaignStatusLabel, dateTime } from '#lib/format.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const status = (value: string) => campaignStatusLabel[value] ?? { label: value, tone: 'neutral' as const };
</script>

<svelte:head>
	<title>Sala de sorteo</title>
</svelte:head>

<section class="list">
	<header>
		<h1>Sala de sorteo</h1>
		<p class="muted">Elegí la campaña cuyo sorteo vas a conducir: cargás los números de la Quiniela, ves los ganadores y sorteás en la app los premios que falten.</p>
	</header>
	{#if data.campaigns.length === 0}
		<p class="notice">Todavía no hay campañas con sorteo. Aparecen acá desde que abren las participaciones.</p>
	{:else}
		<ul class="campaigns">
			{#each data.campaigns as campaign (campaign.id)}
				{@const chip = status(campaign.status)}
				<li>
					<a class="campaign" href="/admin/sala-de-sorteo/{campaign.id}">
						<span class="title">{campaign.title}{campaign.round > 1 ? `, ronda ${campaign.round}` : ''}</span>
						{#if campaign.subtitle}<span class="muted">{campaign.subtitle}</span>{/if}
						<span class="facts">
							<span class="chip {chip.tone}">{chip.label}</span>
							{#if campaign.drawAt}<span class="muted">Sorteo: {dateTime(campaign.drawAt, campaign.timezone)}</span>{/if}
						</span>
					</a>
				</li>
			{/each}
		</ul>
	{/if}
</section>

<style>
	.list {
		display: grid;
		gap: 1.5rem;
		max-width: 56rem;
	}

	header {
		display: grid;
		gap: 0.5rem;
	}

	.campaigns {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 0.75rem;
	}

	.campaign {
		display: grid;
		gap: 0.35rem;
		padding: 1rem 1.25rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		background: var(--surface);
		color: inherit;
		text-decoration: none;
	}

	.campaign:hover,
	.campaign:focus-visible {
		border-color: var(--accent);
	}

	.title {
		font: 800 var(--step-2) / 1.1 var(--font-display);
	}

	.facts {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem 1rem;
	}
</style>
