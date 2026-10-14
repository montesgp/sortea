<script lang="ts">
	import { campaignStatusLabel, dateTime } from '#lib/format.js';
	import type { CampaignSummary } from '#lib/server/types.js';
	import Countdown from './Countdown.svelte';

	let { campaign, serverTime, timezone }: { campaign: CampaignSummary; serverTime: string; timezone: string } = $props();

	const status = $derived(campaignStatusLabel[campaign.status] ?? { label: campaign.status, tone: 'neutral' as const });
	const countdown = $derived(
		campaign.status === 'published'
			? { target: campaign.opensAt, label: 'Faltan para la apertura' }
			: campaign.status === 'open'
				? { target: campaign.closesAt, label: 'Faltan para el cierre' }
				: null
	);
</script>

<section class="band" aria-labelledby="band-title">
	<div class="container inner">
		<div class="text">
			<div class="chips">
				<span class="chip {status.tone}">{status.label}</span>
				{#if campaign.isDemo}<span class="chip neutral">Demostración</span>{/if}
			</div>
			<h2 id="band-title">{campaign.title}</h2>
			<p class="muted">{campaign.summary}</p>
			<dl>
				<div><dt>Apertura</dt><dd>{dateTime(campaign.opensAt, timezone)}</dd></div>
				<div><dt>Cierre</dt><dd>{dateTime(campaign.closesAt, timezone)}</dd></div>
				{#if campaign.drawAt}<div><dt>Transmisión del resultado</dt><dd>{dateTime(campaign.drawAt, timezone)}</dd></div>{/if}
				<div><dt>Premios</dt><dd>{campaign.prizeCount}</dd></div>
			</dl>
		</div>
		<div class="side">
			{#if countdown}<Countdown target={countdown.target} {serverTime} label={countdown.label} />{/if}
			<a class="button" href="/sorteos/{campaign.slug}">Ver la campaña</a>
			<a class="button quiet" href="/sorteos/{campaign.slug}/transparencia">Transparencia y bases</a>
		</div>
	</div>
</section>

<style>
	.band {
		padding-block: clamp(3rem, 2rem + 4vw, 6rem);
		background:
			linear-gradient(115deg, color-mix(in srgb, var(--accent) 22%, transparent), transparent 55%),
			var(--surface);
		border-block: 1px solid var(--border);
	}

	.inner {
		display: grid;
		grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr);
		gap: clamp(2rem, 1rem + 3vw, 4rem);
		align-items: end;
	}

	.chips {
		display: flex;
		gap: 0.5rem;
		flex-wrap: wrap;
		margin-bottom: 1rem;
	}

	h2 {
		font-size: var(--step-4);
		text-transform: uppercase;
		margin-bottom: 1rem;
	}

	.text > p {
		max-width: 58ch;
	}

	dl {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
		gap: 1rem;
		margin: 1.75rem 0 0;
	}

	dt {
		font-size: var(--step--1);
		color: var(--muted);
	}

	dd {
		margin: 0.2rem 0 0;
		font-weight: 700;
	}

	.side {
		display: grid;
		gap: 1rem;
		justify-items: start;
	}

	@media (max-width: 860px) {
		.inner {
			grid-template-columns: 1fr;
		}
	}
</style>
