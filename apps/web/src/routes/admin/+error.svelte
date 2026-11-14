<script lang="ts">
	import { page } from '$app/state';

	// A page of the panel the signed-in role may not open answers 403 (the API decides, PRD §4). The draw host
	// is sent back to the draw room (odd/tasks/draw-room.md T5, S4); every other error reads as on the site.
	const denied = $derived(page.status === 403);
	const roomOnly = $derived(page.error?.code === 'draw_room_only');
</script>

<svelte:head>
	<title>{denied ? 'Sin acceso' : page.status === 404 ? 'No encontrado' : 'Error'}</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<main id="contenido" class="container error">
	<p class="code">{page.status}</p>
	{#if denied}
		<h1>No tenés acceso</h1>
		<p class="muted">{page.error?.message ?? 'Tu usuario no puede ver esta sección.'}</p>
		{#if roomOnly}
			<a class="button" href="/admin/sala-de-sorteo">Volver a la sala de sorteo</a>
		{:else}
			<a class="button" href="/admin">Volver al panel</a>
		{/if}
	{:else}
		<h1>{page.status === 404 ? 'Acá no hay nada' : 'Algo se trabó'}</h1>
		<p class="muted">{page.error?.message ?? 'Probá de nuevo en unos minutos.'}</p>
		<a class="button" href="/admin">Volver al panel</a>
	{/if}
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
