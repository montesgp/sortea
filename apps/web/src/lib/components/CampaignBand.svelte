<script lang="ts">
	import { chancesExampleText, type ChancesExample } from '#lib/chances.js';
	import { campaignStatusLabel, dateTime } from '#lib/format.js';
	import type { CampaignSummary } from '#lib/server/types.js';
	import Countdown from './Countdown.svelte';
	import VideoPlayer from './VideoPlayer.svelte';

	/**
	 * The campaign block that goes first wherever a campaign exists (S8): right
	 * after the hero on the home, and on top of the shop as the hook that leads
	 * to the products (`shop`, where its title is the page heading).
	 */
	let {
		campaign,
		serverTime,
		timezone,
		variant = 'home',
		example = null
	}: { campaign: CampaignSummary; serverTime: string; timezone: string; variant?: 'home' | 'shop'; example?: ChancesExample | null } = $props();

	const status = $derived(campaignStatusLabel[campaign.status] ?? { label: campaign.status, tone: 'neutral' as const });
	const countdown = $derived(
		campaign.status === 'published'
			? { target: campaign.opensAt, label: 'Faltan para la apertura', live: false, reached: 'La apertura es inminente' }
			: campaign.status === 'open'
				? { target: campaign.closesAt, label: 'Faltan para el cierre', live: true, reached: 'Las participaciones cerraron' }
				: null
	);
	const heading = $derived(variant === 'shop' ? 'h1' : 'h2');
	const subheading = $derived(variant === 'shop' ? 'h2' : 'h3');
</script>

<section class="band {variant}" aria-labelledby="band-title">
	<div class="container inner">
		<div class="text">
			<div class="chips">
				<span class="chip {status.tone}">{status.label}</span>
				{#if campaign.isDemo}<span class="chip neutral">Demostración</span>{/if}
			</div>
			<svelte:element this={heading} id="band-title">{campaign.title}</svelte:element>
			{#if campaign.subtitle}<p class="subtitle">{campaign.subtitle}</p>{/if}
			<p class="muted summary">{campaign.summary}</p>
			<dl>
				<div><dt>Apertura</dt><dd>{dateTime(campaign.opensAt, timezone)}</dd></div>
				<div><dt>Cierre</dt><dd>{dateTime(campaign.closesAt, timezone)}</dd></div>
				{#if campaign.drawAt}<div><dt>Transmisión del resultado</dt><dd>{dateTime(campaign.drawAt, timezone)}</dd></div>{/if}
			</dl>
		</div>
		<div class="side">
			{#if campaign.video}<VideoPlayer video={campaign.video} title="Video de {campaign.title}" />{/if}
			{#if countdown}<Countdown target={countdown.target} {serverTime} label={countdown.label} live={countdown.live} reached={countdown.reached} />{/if}
			{#if example}
				<!-- Counted by the API from the locked rules; the big number only repeats the sentence. -->
				<div class="example">
					<span class="plus" aria-hidden="true">+{example.count}</span>
					<p>{chancesExampleText(example)}</p>
				</div>
			{/if}
			<div class="actions">
				{#if variant === 'shop'}
					<a class="button" href="#productos">Ver los productos</a>
					<a class="button secondary" href="/sorteos/{campaign.slug}">Ver la campaña</a>
				{:else}
					<a class="button" href="/sorteos/{campaign.slug}">Ver la campaña</a>
				{/if}
				<a class="button quiet" href="/sorteos/{campaign.slug}/transparencia">Transparencia y bases</a>
			</div>
		</div>

		{#if campaign.prizes.length}
			<div class="prizes">
				<svelte:element this={subheading} id="band-prizes" class="prizes-title">Premios</svelte:element>
				<ul aria-labelledby="band-prizes">
					{#each campaign.prizes as prize (prize.position)}
						<li>
							<div class="art">
								{#if prize.video}
									<VideoPlayer video={prize.video} title="Video de {prize.title}" />
								{:else if prize.imageUrl}
									<img src={prize.imageUrl} alt={prize.title} loading="lazy" />
								{:else}
									<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M20 10h24v14a12 12 0 0 1-24 0zM20 14H10v4a10 10 0 0 0 10 10M44 14h10v4a10 10 0 0 1-10 10M32 36v12M22 54h20l-3-6H25z" /></svg>
								{/if}
							</div>
							<p class="prize-title">{prize.title}</p>
							<p class="muted quantity">{prize.quantity === 1 ? '1 premio' : `${prize.quantity} premios`}</p>
						</li>
					{/each}
				</ul>
			</div>
		{/if}
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

	.band.shop {
		padding-block: clamp(2.5rem, 2rem + 3vw, 4.5rem);
	}

	.inner {
		display: grid;
		grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr);
		gap: clamp(2rem, 1rem + 3vw, 4rem);
		align-items: start;
	}

	.chips {
		display: flex;
		gap: 0.5rem;
		flex-wrap: wrap;
		margin-bottom: 1rem;
	}

	#band-title {
		font-size: var(--step-4);
		text-transform: uppercase;
		margin-bottom: 1rem;
		overflow-wrap: anywhere;
	}

	.subtitle {
		font-weight: 700;
		font-size: var(--step-1);
		margin-bottom: 0.5rem;
	}

	.summary {
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
		gap: 1.25rem;
		justify-items: start;
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.75rem;
	}

	/* The example is the loudest thing in the block: an accent frame and a big number. */
	.example {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr);
		align-items: center;
		gap: 1rem;
		justify-self: stretch;
		padding: 1rem 1.25rem;
		border: 2px solid var(--accent);
		border-radius: var(--radius);
		background: color-mix(in srgb, var(--accent) 14%, var(--surface));
	}

	.plus {
		font: 800 var(--step-4) / 1 var(--font-display);
		color: var(--accent);
	}

	.example p {
		font-weight: 700;
		font-size: var(--step-1);
		line-height: 1.3;
	}

	.prizes {
		grid-column: 1 / -1;
	}

	.prizes-title {
		font-size: var(--step-2);
		text-transform: uppercase;
		margin-bottom: 1rem;
	}

	.prizes ul {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(min(100%, 200px), 1fr));
		gap: 1rem;
	}

	.prizes li {
		display: grid;
		align-content: start;
		gap: 0.35rem;
		padding: 0.75rem;
		background: var(--surface-2);
		border: 1px solid var(--border);
		border-radius: var(--radius);
	}

	.art {
		display: grid;
		place-items: center;
		aspect-ratio: 4 / 3;
		margin-bottom: 0.25rem;
		border-radius: var(--radius-sm);
		background:
			repeating-linear-gradient(135deg, transparent 0 14px, color-mix(in srgb, var(--text) 5%, transparent) 14px 15px),
			var(--bg);
	}

	.art img {
		width: 100%;
		height: 100%;
		object-fit: cover;
		border-radius: inherit;
	}

	.art svg {
		width: 30%;
		fill: none;
		stroke: var(--text);
		stroke-width: 2.5;
		stroke-linejoin: round;
	}

	.prize-title {
		font: 800 var(--step-1) / 1.1 var(--font-display);
		text-transform: uppercase;
	}

	.quantity {
		font-size: var(--step--1);
	}

	@media (max-width: 860px) {
		.inner {
			grid-template-columns: 1fr;
		}
	}

	@media (max-width: 520px) {
		.prizes ul {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}
</style>
