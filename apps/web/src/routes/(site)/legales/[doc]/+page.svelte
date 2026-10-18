<script lang="ts">
	import LegalDocument from '#lib/components/legal/LegalDocument.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const name = $derived(data.site?.organization.name ?? '');
</script>

<svelte:head>
	<title>{data.title} | {name}</title>
</svelte:head>

<article class="container page prose">
	<h1>{data.title}</h1>
	<LegalDocument doc={data} />
</article>

<style>
	.page {
		padding-top: clamp(2.5rem, 2rem + 3vw, 5rem);
	}

	h1 {
		font-size: var(--step-4);
		text-transform: uppercase;
		margin-bottom: 1.5rem;
	}
</style>
