<script lang="ts">
	import { money } from '#lib/format.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const preference = $derived(data.preference);
</script>

<svelte:head>
	<title>Simulador de pagos</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<section class="container page">
	<p class="chip warn">Entorno de desarrollo</p>
	<h1>Simulador de pagos</h1>
	<p class="muted">Este paso reemplaza a Mercado Pago en local. Elegí el resultado: la confirmación llega igual que en producción, por una notificación firmada que el servidor verifica.</p>

	{#if form?.message}<p class="notice error">{form.message}</p>{/if}

	<div class="panel">
		<p class="muted">Orden {preference.reference}</p>
		<ul>
			{#each preference.items as item (item.title)}
				<li><span>{item.title} × {item.quantity}</span><span class="money">{money(item.unitPriceMinor * item.quantity, item.currency)}</span></li>
			{/each}
		</ul>
		<p class="total"><span>Total</span><span class="money">{money(preference.totalMinor)}</span></p>
		<form method="POST" class="actions">
			<input type="hidden" name="preferenceId" value={preference.id} />
			<button class="button" name="outcome" value="approved">Aprobar pago</button>
			<button class="button secondary" name="outcome" value="in_process">Dejar pendiente</button>
			<button class="button secondary" name="outcome" value="rejected">Rechazar pago</button>
		</form>
	</div>
</section>

<style>
	.page {
		padding-top: clamp(2.5rem, 2rem + 3vw, 5rem);
		max-width: 680px;
		display: grid;
		gap: 1rem;
		justify-items: start;
	}

	h1 {
		font-size: var(--step-4);
		text-transform: uppercase;
	}

	.panel {
		width: 100%;
		display: grid;
		gap: 1rem;
	}

	ul {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 0.5rem;
	}

	li,
	.total {
		display: flex;
		justify-content: space-between;
	}

	.total {
		font: 800 var(--step-2) / 1 var(--font-display);
		border-top: 1px solid var(--border);
		padding-top: 0.75rem;
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.75rem;
	}
</style>
