<script lang="ts">
	import CampaignBand from '#lib/components/CampaignBand.svelte';
	import CampaignContent from '#lib/components/CampaignContent.svelte';
	import LinkPreview from '#lib/components/LinkPreview.svelte';
	import ProductCard from '#lib/components/ProductCard.svelte';
	import { campaignStatusLabel } from '#lib/format.js';
	import { campaignShareImage } from '#lib/link-preview.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const status = $derived(data.featured ? (campaignStatusLabel[data.featured.status] ?? { label: data.featured.status, tone: 'neutral' as const }) : null);
	const open = $derived(data.featured?.status === 'open');
	const organization = $derived(data.site?.organization.name ?? '');
	const description = $derived(data.campaign?.seo.description ?? data.campaign?.summary ?? `Productos digitales y físicos de ${organization}.`);
</script>

<svelte:head>
	<title>Tienda | {data.site?.organization.name}</title>
	<meta name="description" content={description} />
</svelte:head>

{#if data.origin}
	<LinkPreview
		title={data.featured ? `Participaciones por ${data.featured.title} | ${organization}` : `Tienda | ${organization}`}
		{description}
		url={new URL('/tienda', data.origin).href}
		image={data.campaign ? campaignShareImage(data.campaign, data.origin) : null}
		siteName={organization}
	/>
{/if}

<!--
	The shop is the page linked from social media, where the campaign is already
	explained (owner feedback 2026-11-15 S1): a short heading that invites to buy
	and take part (S2), the products right after it, and the campaign after the
	last product, with everything its page shows (2026-11-15c S2).
-->
<section class="container page" id="productos" aria-labelledby="shop-title">
	{#if data.featured && status}
		<div class="hero" class:open>
			<div class="chips">
				<span class="chip {status.tone}" class:live={open}>{status.label}</span>
				{#if data.featured.isDemo}<span class="chip neutral">Demostración</span>{/if}
			</div>
			<h1 id="shop-title"><span class="kicker">Participaciones por</span> <span class="campaign">{data.featured.title}</span></h1>
			<!-- Only while a purchase gives chances: none once the coupons ran out (ADR 0014 §1). -->
			{#if open && data.chances}<p class="invite">Cada compra te suma chances para ganar. Elegí tu producto y participá.</p>{/if}
		</div>
	{:else}
		<h1 id="shop-title">Tienda</h1>
	{/if}
	<p class="muted lead">Comprás sin crear una cuenta. Los productos digitales llegan a tu email apenas se confirma el pago.</p>

	{#if data.unavailable}
		<p class="notice error">La tienda no está disponible en este momento. Probá de nuevo en unos minutos.</p>
	{:else if data.products.length === 0}
		<p class="notice">Todavía no hay productos publicados.</p>
	{:else}
		<div class="grid">
			{#each data.products as product (product.id)}
				<ProductCard {product} chances={data.chances} />
			{/each}
		</div>
	{/if}
</section>

{#if data.campaign}
	<CampaignContent campaign={data.campaign} rulesHtml={data.rulesHtml} demoPayments={data.site?.demoPayments ?? null} from="tienda" productsAbove />
{:else if data.featured}
	<!-- The campaign detail did not load: the summary band still links to it. -->
	<CampaignBand campaign={data.featured} serverTime={data.serverTime} timezone={data.site!.organization.timezone} example={data.example} from="tienda" />
{/if}

<style>
	.page {
		padding-block: clamp(2rem, 1.5rem + 2vw, 3.5rem) clamp(2.5rem, 2rem + 3vw, 5rem);
		scroll-margin-top: 5rem;
	}

	/* A short heading: the products are what this page leads with (S1). */
	h1 {
		font-size: var(--step-3);
		text-transform: uppercase;
	}

	.chips {
		display: flex;
		gap: 0.5rem;
		flex-wrap: wrap;
		margin-bottom: 0.75rem;
	}

	.hero h1 {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		line-height: 0.95;
	}

	.kicker {
		font-size: var(--step-1);
		letter-spacing: 0.08em;
		color: var(--muted);
	}

	.campaign {
		font-size: var(--step-5);
		color: var(--accent);
	}

	.invite {
		margin: 0.85rem 0 0;
		font-size: var(--step-1);
		font-weight: 600;
	}

	/* On a phone the first product still shows on the first screen. */
	@media (max-width: 600px) {
		.kicker {
			font-size: var(--step-0);
		}

		.campaign {
			font-size: var(--step-4);
		}

		.invite {
			margin-top: 0.6rem;
			font-size: var(--step-0);
		}

		.lead {
			font-size: var(--step--1);
		}
	}

	/* Motion invites without getting in the way: a staggered entrance, a light sweep over the
	   campaign name now and then, and the open pill's dot breathing. None with reduced motion (S2). */
	@media (prefers-reduced-motion: no-preference) {
		.hero > * {
			animation: rise 0.6s cubic-bezier(0.2, 0.7, 0.2, 1) both;
		}

		.hero > :nth-child(2) {
			animation-delay: 0.08s;
		}

		.hero > :nth-child(3) {
			animation-delay: 0.16s;
		}

		.hero.open .campaign {
			background: linear-gradient(100deg, var(--accent) 40%, color-mix(in srgb, var(--accent) 35%, white) 50%, var(--accent) 60%) 0 0 / 250% 100%;
			-webkit-background-clip: text;
			background-clip: text;
			color: transparent;
			animation: sweep 4.5s ease-in-out 0.8s infinite;
		}

		.chip.live::before {
			animation: breathe 1.6s ease-in-out infinite;
		}
	}

	@keyframes rise {
		from {
			opacity: 0;
			transform: translateY(0.75rem);
		}
	}

	@keyframes sweep {
		0% {
			background-position: 100% 0;
		}
		45%,
		100% {
			background-position: 0 0;
		}
	}

	@keyframes breathe {
		50% {
			box-shadow: 0 0 0 0.35rem color-mix(in srgb, currentColor 25%, transparent);
			transform: scale(1.15);
		}
	}

	.lead {
		margin: 0.6rem 0 1.5rem;
		max-width: 60ch;
	}

	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
		/* Every row as tall as the tallest card, so all cards share one layout (S4). */
		grid-auto-rows: 1fr;
		gap: 1.25rem;
	}
</style>
