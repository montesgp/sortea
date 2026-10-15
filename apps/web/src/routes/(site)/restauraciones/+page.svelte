<script lang="ts">
	import PhotoCredit from '#lib/components/PhotoCredit.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const gallery = $derived(data.gallery);
	const name = $derived(data.site?.organization.name ?? '');
	const description = $derived(gallery.lead ?? `${gallery.title} de ${name}: ${gallery.items.map((item) => item.title).join(', ')}.`);
</script>

<svelte:head>
	<title>{gallery.title} | {name}</title>
	<meta name="description" content={description.slice(0, 200)} />
	<meta property="og:title" content="{gallery.title} | {name}" />
	<meta property="og:description" content={description.slice(0, 200)} />
	<meta property="og:image" content={gallery.items[0]!.image} />
</svelte:head>

<div class="container page">
	<header class="intro">
		<h1>{gallery.title}</h1>
		{#if gallery.lead}<p class="lead">{gallery.lead}</p>{/if}
		{#if gallery.note}<p class="note" role="note">{gallery.note}</p>{/if}
	</header>

	<ul class="grid">
		{#each gallery.items as item, index (index)}
			<li>
				<figure>
					<img src={item.image} alt={item.alt} loading={index < 2 ? 'eager' : 'lazy'} />
					<figcaption>
						<h2>{item.title}</h2>
						{#if item.body}<p>{item.body}</p>{/if}
						{#if item.credit}<PhotoCredit credit={item.credit} photo={item.title} />{/if}
					</figcaption>
				</figure>
			</li>
		{/each}
	</ul>
</div>

<style>
	.page {
		padding-block: clamp(2.5rem, 2rem + 3vw, 5rem);
	}

	.intro {
		display: grid;
		gap: 1rem;
		max-width: 68ch;
		margin-bottom: clamp(2rem, 1.5rem + 2vw, 3rem);
	}

	h1 {
		font-size: var(--step-5);
		text-transform: uppercase;
	}

	.lead {
		font-size: var(--step-1);
		line-height: 1.45;
	}

	/* The photos are examples, not the workshop's work: say so before the first one. */
	.note {
		margin: 0;
		padding: 0.75rem 1rem;
		border-inline-start: 4px solid var(--accent);
		background: var(--surface-2);
		border-radius: var(--radius-sm);
		font-weight: 600;
	}

	.grid {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(min(100%, 340px), 1fr));
		gap: clamp(1.25rem, 1rem + 1vw, 2rem);
	}

	figure {
		margin: 0;
		display: grid;
		gap: 0.75rem;
	}

	img {
		width: 100%;
		aspect-ratio: 4 / 3;
		object-fit: cover;
		border-radius: var(--radius-sm);
		background: var(--surface-2);
	}

	figcaption {
		display: grid;
		gap: 0.4rem;
	}

	h2 {
		font-size: var(--step-1);
		text-transform: uppercase;
	}

	figcaption p {
		margin: 0;
		max-width: 52ch;
	}
</style>
