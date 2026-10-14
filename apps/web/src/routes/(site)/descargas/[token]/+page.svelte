<script lang="ts">
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<svelte:head>
	<title>Descarga no disponible</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<section class="container page">
	<h1>Este enlace ya no funciona</h1>
	<p class="muted">{data.message}</p>
	<a class="button" href="/consulta">Pedir un enlace nuevo</a>
</section>

<style>
	.page {
		padding-top: clamp(2.5rem, 2rem + 3vw, 5rem);
		display: grid;
		gap: 1rem;
		justify-items: start;
	}

	h1 {
		font-size: var(--step-4);
		text-transform: uppercase;
	}
</style>
