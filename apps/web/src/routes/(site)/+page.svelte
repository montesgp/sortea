<script lang="ts">
	import CampaignBand from '#lib/components/CampaignBand.svelte';
	import GarageHero from '#lib/components/home/GarageHero.svelte';
	import PistonCycle from '#lib/components/home/PistonCycle.svelte';
	import SimpleHero from '#lib/components/home/SimpleHero.svelte';
	import PhotoCredit from '#lib/components/PhotoCredit.svelte';
	import ProductCard from '#lib/components/ProductCard.svelte';
	import SocialLinks from '#lib/components/SocialLinks.svelte';
	import { galleryOnHome } from '#lib/gallery.js';
	import { youtubeEmbed } from '#lib/youtube.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const site = $derived(data.site!);
	const home = $derived(site.content.home);
	// SEO from the CMS wins; without it, the home copy describes the site.
	const seo = $derived(site.content.seo);
	const title = $derived(seo?.title ?? `${site.organization.name}${site.content.brand?.tagline ? ` | ${site.content.brand.tagline}` : ''}`);
	const description = $derived(seo?.description ?? home?.heroLead ?? site.content.brand?.tagline ?? site.organization.name);
	const shareImage = $derived(seo?.image ?? home?.heroImage ?? null);
	const video = $derived(youtubeEmbed(home?.heroVideoUrl ?? null));
	const gallery = $derived(galleryOnHome(site.content));
</script>

<svelte:head>
	<title>{title}</title>
	<meta name="description" content={description} />
	<meta property="og:type" content="website" />
	<meta property="og:site_name" content={site.organization.name} />
	<meta property="og:title" content={seo?.title ?? site.organization.name} />
	<meta property="og:description" content={description} />
	{#if shareImage}<meta property="og:image" content={shareImage} />{/if}
</svelte:head>

{#if home}
	{@const primary = data.featured ? { href: `/sorteos/${data.featured.slug}`, label: 'Ver la campaña' } : { href: '/tienda', label: 'Ver la tienda' }}
	{@const secondary = data.featured ? { href: '/tienda', label: 'Ver la tienda' } : undefined}
	{#if home.heroStyle === 'garage'}
		<GarageHero title={home.heroTitle} lead={home.heroLead} image={home.heroImage} imageAlt={home.heroImageAlt ?? ''} {primary} {secondary} place={site.contact.city} />
	{:else}
		<SimpleHero title={home.heroTitle} lead={home.heroLead} image={home.heroImage} imageAlt={home.heroImageAlt ?? ''} {primary} {secondary} />
	{/if}
{/if}

<!-- The campaign comes first, right after the hero; the corporate part follows (S8). -->
{#if data.featured}
	<CampaignBand campaign={data.featured} serverTime={data.serverTime} timezone={site.organization.timezone} example={data.example} />
{/if}

{#if home}
	{#if video}
		<section class="container video-block" aria-label="Video">
			<div class="video"><iframe src={video} title="Video de {site.organization.name}" loading="lazy" allow="encrypted-media; picture-in-picture" allowfullscreen></iframe></div>
		</section>
	{/if}

	{#if home.services.length}
		<section class="wall" aria-labelledby="services-title">
			<div class="container">
				<h2 id="services-title">{home.servicesTitle ?? 'Lo que hacemos'}</h2>
				<ul>
					{#each home.services as service (service.title)}
						<li>
							<h3>{service.title}</h3>
							<p>{service.body}</p>
						</li>
					{/each}
				</ul>
			</div>
		</section>
	{/if}

	{#if home.process.length && home.processStyle === 'pistons'}
		<PistonCycle title={home.processTitle ?? 'Cómo trabajamos'} steps={home.process} />
	{:else if home.process.length}
		<section class="container steps" aria-labelledby="steps-title">
			<h2 id="steps-title">{home.processTitle ?? 'Cómo trabajamos'}</h2>
			<ol>
				{#each home.process as step (step.title)}
					<li><h3>{step.title}</h3><p class="muted">{step.body}</p></li>
				{/each}
			</ol>
		</section>
	{/if}
{/if}

{#if gallery}
	<section class="container gallery" aria-labelledby="gallery-title">
		<div class="shop-head">
			<div class="gallery-intro">
				<h2 id="gallery-title">{gallery.title}</h2>
				{#if gallery.lead}<p class="muted">{gallery.lead}</p>{/if}
			</div>
			<a class="button secondary small" href="/restauraciones">Ver restauraciones</a>
		</div>
		<ul class="teaser">
			{#each gallery.items.slice(0, 3) as item, index (index)}
				<li>
					<figure>
						<img src={item.image} alt={item.alt} loading="lazy" />
						<figcaption>
							<strong>{item.title}</strong>
							{#if item.credit}<PhotoCredit credit={item.credit} photo={item.title} />{/if}
						</figcaption>
					</figure>
				</li>
			{/each}
		</ul>
		{#if gallery.note}<p class="gallery-note muted">{gallery.note}</p>{/if}
	</section>
{/if}

{#if data.products.length}
	<section class="shop container" aria-labelledby="shop-title">
		<div class="shop-head">
			<h2 id="shop-title">De la tienda</h2>
			<a class="button secondary small" href="/tienda">Ver todo</a>
		</div>
		<div class="products">
			{#each data.products as product (product.id)}
				<ProductCard {product} chances={data.chances} />
			{/each}
		</div>
	</section>
{/if}

{#if site.faqs.length}
	<section class="container faqs" aria-labelledby="faq-title">
		<h2 id="faq-title">Preguntas frecuentes</h2>
		{#each site.faqs as faq (faq.id)}
			<details>
				<summary>{faq.question}</summary>
				<p>{faq.answer}</p>
			</details>
		{/each}
	</section>
{/if}

{#if home && Object.values(site.social).some(Boolean)}
	<section class="container follow" aria-labelledby="follow-title">
		<h2 id="follow-title">{home.ctaTitle}</h2>
		<p class="muted">{home.ctaBody}</p>
		<SocialLinks social={site.social} variant="buttons" />
	</section>
{/if}

<style>
	.faqs {
		padding-block: clamp(2.5rem, 2rem + 3vw, 5rem);
	}

	.faqs details {
		border-bottom: 1px solid var(--border);
		padding-block: 1rem;
	}

	.faqs summary {
		cursor: pointer;
		font-weight: 700;
	}

	.faqs details p {
		margin-top: 0.75rem;
		color: var(--muted);
		max-width: 68ch;
	}

	.video-block {
		padding-block: clamp(2rem, 1.5rem + 3vw, 4rem);
	}

	.video {
		aspect-ratio: 16 / 9;
		border-radius: var(--radius-sm);
		overflow: hidden;
		background: #000;
	}

	.video iframe {
		width: 100%;
		height: 100%;
		border: 0;
	}

	/* The workshop wall: an inverted band, like white paint behind the black sign. */
	.wall {
		background: var(--text);
		color: var(--bg);
		padding-block: clamp(4rem, 3rem + 5vw, 8rem);
	}

	.wall h2 {
		font-size: var(--step-4);
		text-transform: uppercase;
		max-width: 14ch;
		margin-bottom: clamp(2rem, 1rem + 3vw, 4rem);
	}

	.wall ul {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.wall li {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 1.1fr);
		gap: 1rem 3rem;
		align-items: baseline;
		padding-block: 1.5rem;
		border-top: 2px solid color-mix(in srgb, var(--bg) 85%, transparent);
	}

	.wall li:last-child {
		border-bottom: 2px solid color-mix(in srgb, var(--bg) 85%, transparent);
	}

	.wall h3 {
		font-size: var(--step-3);
		text-transform: uppercase;
	}

	.wall li p {
		max-width: 48ch;
		font-size: var(--step-1);
		line-height: 1.45;
	}

	.steps {
		padding-top: clamp(4rem, 3rem + 4vw, 7rem);
	}

	.steps h2 {
		font-size: var(--step-4);
		margin-bottom: 2rem;
	}

	.steps ol {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
		gap: 1.5rem;
		padding-left: 1.2rem;
	}

	.shop {
		padding-block: clamp(4rem, 3rem + 4vw, 7rem) 0;
	}

	.shop-head {
		display: flex;
		align-items: end;
		justify-content: space-between;
		gap: 1rem;
		margin-bottom: 2rem;
	}

	.shop h2,
	.follow h2 {
		font-size: var(--step-4);
		text-transform: uppercase;
	}

	.products {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
		/* Every row as tall as the tallest card, so all cards share one layout (S4). */
		grid-auto-rows: 1fr;
		gap: 1.25rem;
	}

	.gallery {
		padding-top: clamp(4rem, 3rem + 4vw, 7rem);
	}

	/* The intro can be long: the button drops below it on narrow screens. */
	.gallery .shop-head {
		flex-wrap: wrap;
	}

	.gallery h2 {
		font-size: var(--step-4);
		text-transform: uppercase;
	}

	.gallery-intro {
		display: grid;
		gap: 0.5rem;
		max-width: 60ch;
	}

	.teaser {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 260px), 1fr));
		gap: 1.25rem;
	}

	.teaser figure {
		margin: 0;
		display: grid;
		gap: 0.5rem;
	}

	.teaser img {
		width: 100%;
		aspect-ratio: 4 / 3;
		object-fit: cover;
		border-radius: var(--radius-sm);
		background: var(--surface-2);
	}

	.teaser figcaption {
		display: grid;
		gap: 0.2rem;
	}

	.gallery-note {
		margin-top: 1rem;
		font-size: var(--step--1);
	}

	.follow {
		display: grid;
		justify-items: start;
		gap: 1rem;
		padding-top: clamp(4rem, 3rem + 4vw, 7rem);
	}

	.follow p {
		max-width: 52ch;
	}

	@media (max-width: 760px) {
		.wall li {
			grid-template-columns: 1fr;
		}
	}
</style>
