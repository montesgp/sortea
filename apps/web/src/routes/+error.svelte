<script lang="ts">
	import { page } from '$app/state';
</script>

<svelte:head>
	<title>{page.status === 404 ? 'No encontrado' : 'Error'}</title>
</svelte:head>

<main id="contenido" class="container error">
	<p class="code">{page.status}</p>
	<h1>{page.status === 404 ? 'Acá no hay nada' : 'Algo se trabó'}</h1>
	<p class="muted">{page.error?.message ?? 'Probá de nuevo en unos minutos.'}</p>
	<a class="button" href="/">Volver al inicio</a>
</main>

<style>
	.error {
		min-height: 80dvh;
		display: grid;
		align-content: center;
		justify-items: start;
		gap: 1.2rem;
	}

	.code {
		font: 800 var(--step-5) / 0.9 var(--font-display);
		color: var(--accent);
	}

	h1 {
		font-size: var(--step-4);
	}
</style>
