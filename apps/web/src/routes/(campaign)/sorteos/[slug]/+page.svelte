<script lang="ts">
	import CampaignContent from '#lib/components/CampaignContent.svelte';
	import LinkPreview from '#lib/components/LinkPreview.svelte';
	import ProductCard from '#lib/components/ProductCard.svelte';
	import { campaignShareImage } from '#lib/link-preview.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const campaign = $derived(data.campaign);
	const site = $derived(data.site);
	const description = $derived(campaign.seo.description ?? campaign.summary);
</script>

<svelte:head>
	<title>{campaign.seo.title ?? `${campaign.title} | ${site?.organization.name}`}</title>
	<meta name="description" content={description} />
</svelte:head>

{#if data.origin}
	<LinkPreview
		title={campaign.seo.title ?? campaign.title}
		{description}
		url={new URL(`/sorteos/${campaign.slug}`, data.origin).href}
		image={campaignShareImage(campaign, data.origin)}
		siteName={site?.organization.name ?? campaign.title}
	/>
{/if}

<CampaignContent {campaign} rulesHtml={data.rulesHtml} demoPayments={site?.demoPayments ?? null}>
	{#snippet products()}
		<div class="products">
			{#each data.products as product (product.id)}
				<ProductCard {product} campaign={campaign.slug} chances={data.chances} />
			{/each}
		</div>
	{/snippet}
</CampaignContent>

<style>
	.products {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
		/* Every row as tall as the tallest card, so all cards share one layout (S4). */
		grid-auto-rows: 1fr;
		gap: 1.25rem;
	}
</style>
