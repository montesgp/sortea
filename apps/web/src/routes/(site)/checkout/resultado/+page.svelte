<script lang="ts">
	import { refreshAll } from '$app/navigation';
	import { money, orderStatusLabel } from '#lib/format.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const order = $derived(data.order);
	const waiting = $derived(order?.status === 'pending_payment');

	// While the payment is pending, ask the server again every few seconds for up to two minutes.
	$effect(() => {
		if (!waiting) return;
		let rounds = 0;
		const timer = setInterval(() => {
			rounds += 1;
			if (rounds > 40) clearInterval(timer);
			else refreshAll();
		}, 3000);
		return () => clearInterval(timer);
	});
</script>

<svelte:head>
	<title>Estado de tu compra | {data.site?.organization.name}</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<section class="container page" aria-live="polite">
	{#if !order}
		<h1>No encontramos tu compra en este navegador</h1>
		<p class="muted">Si ya pagaste, revisá tu email o consultá tus compras con tu documento.</p>
		<a class="button" href="/consulta">Consultar mis compras</a>
	{:else}
		{@const status = orderStatusLabel[order.status] ?? { label: order.status, tone: 'neutral' }}
		<span class="chip {status.tone}">{status.label}</span>
		{#if order.status === 'paid'}
			<h1>¡Listo! Tu compra está confirmada</h1>
			<p class="lead">Te enviamos el comprobante y los enlaces de descarga a {order.email}.</p>
		{:else if waiting}
			<h1>Estamos esperando la confirmación de Mercado Pago</h1>
			<p class="lead muted">Suele tardar unos segundos. Esta página se actualiza sola; no hace falta que pagues de nuevo.</p>
		{:else if order.status === 'payment_failed'}
			<h1>El pago no se aprobó</h1>
			<p class="lead muted">No se cobró nada. Podés intentarlo de nuevo con otro medio de pago.</p>
			<a class="button" href="/tienda">Volver a la tienda</a>
		{:else}
			<h1>Tu compra está {status.label.toLowerCase()}</h1>
		{/if}

		<div class="panel receipt">
			<dl>
				<div><dt>Comprobante</dt><dd class="code">{order.reference}</dd></div>
				<div><dt>Código de acceso</dt><dd class="code">{data.accessCode}</dd></div>
				<div><dt>Total</dt><dd class="money">{money(order.totalMinor, order.currency)}</dd></div>
			</dl>
			<p class="muted small">Guardá el comprobante y el código: con ellos podés ver esta compra desde Consultar sin recibir un email.</p>
			<ul>
				{#each order.items as item (item.name)}
					<li><span>{item.name} × {item.quantity}</span><span class="money">{money(item.lineTotalMinor, order.currency)}</span></li>
				{/each}
			</ul>
			{#if order.entries.length}
				<div>
					<p><strong>Tus chances ({order.entries.length}):</strong> {order.entries.map((entry) => `#${entry}`).join(', ')}</p>
					<p class="muted small">Cada chance es un cupón numerado en el sorteo.</p>
				</div>
			{/if}
		</div>
	{/if}
</section>

<style>
	.page {
		padding-top: clamp(2.5rem, 2rem + 3vw, 5rem);
		display: grid;
		gap: 1.25rem;
		justify-items: start;
		max-width: 760px;
	}

	h1 {
		font-size: var(--step-4);
		text-transform: uppercase;
	}

	.lead {
		font-size: var(--step-1);
	}

	.receipt {
		width: 100%;
		display: grid;
		gap: 1rem;
	}

	dl {
		margin: 0;
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
		gap: 1rem;
	}

	dt {
		font-size: var(--step--1);
		color: var(--muted);
	}

	dd {
		margin: 0.2rem 0 0;
		font-weight: 700;
	}

	.code {
		font: 800 var(--step-2) / 1 var(--font-display);
		letter-spacing: 0.04em;
	}

	ul {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 0.5rem;
		border-top: 1px solid var(--border);
		padding-top: 1rem;
	}

	li {
		display: flex;
		justify-content: space-between;
		gap: 1rem;
	}

	.small {
		font-size: var(--step--1);
	}
</style>
