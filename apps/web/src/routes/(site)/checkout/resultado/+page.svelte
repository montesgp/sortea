<script lang="ts">
	import { formatEntryNumber, whatsappLink } from '@sortea/domain';
	import { onMount } from 'svelte';
	import { refreshAll } from '$app/navigation';
	import { clearCheckoutDraft } from '#lib/checkout-draft.js';
	import ChancesBadge from '#lib/components/ChancesBadge.svelte';
	import CopySummary from '#lib/components/CopySummary.svelte';
	import { money, orderStatusLabel } from '#lib/format.js';
	import { STATUS_POLL } from '#lib/order-status.js';
	import { orderSummaryText } from '#lib/order-summary.js';
	import type { PageProps } from './$types';

	// The order was handed to the payment: what was typed for it is not kept any longer.
	onMount(() => clearCheckoutDraft(sessionStorage));

	let { data }: PageProps = $props();
	// A refresh the API could not answer keeps showing the order this browser already saw (S7).
	let lastSeen = $state<NonNullable<PageProps['data']['order']> | null>(null);
	$effect(() => {
		if (data.order) lastSeen = data.order;
	});
	const order = $derived(data.order ?? (data.unavailable && lastSeen?.reference === data.reference ? lastSeen : null));
	const waiting = $derived(order?.status === 'pending_payment');
	const contact = $derived(data.site?.contact ?? {});
	const reference = $derived(order?.reference ?? data.reference ?? '');
	const whatsapp = $derived(whatsappLink(contact.whatsapp, `Hola, quiero revisar mi compra ${reference}`));
	// Built only when the buyer asks for it (S1).
	const summary = $derived.by(() => {
		const paid = order?.status === 'paid' ? order : null;
		if (!paid) return null;
		return () =>
			orderSummaryText({
				site: data.site?.organization.name ?? '',
				reference: paid.reference,
				createdAt: paid.createdAt,
				timezone: data.site?.organization.timezone ?? 'America/Argentina/Buenos_Aires',
				currency: paid.currency,
				totalMinor: paid.totalMinor,
				items: paid.items,
				coupons: paid.chances ? { campaign: paid.chances.campaign, entryDigits: paid.entryDigits, numbers: paid.entries } : null
			});
	});

	// While the payment is pending, ask the server again for up to two minutes, within the API's
	// rate limit for this check; a refresh it could not answer stops asking.
	$effect(() => {
		if (!waiting || data.unavailable) return;
		let rounds = 0;
		const timer = setInterval(() => {
			rounds += 1;
			if (rounds > STATUS_POLL.rounds) clearInterval(timer);
			else refreshAll();
		}, STATUS_POLL.intervalMs);
		return () => clearInterval(timer);
	});
</script>

<svelte:head>
	<title>Estado de tu compra | {data.site?.organization.name}</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<section class="container page" aria-live="polite">
	{#if !order && data.unavailable}
		<h1>No pudimos consultar el estado de tu compra ahora</h1>
		<p class="lead muted">Tu compra <strong class="nowrap">{data.reference}</strong> está guardada en este navegador. Probá de nuevo en unos minutos.</p>
		<p class="muted">Si ya pagaste, no pagues de nuevo: cuando se confirme te enviamos el comprobante por email.</p>
		<a class="button" href="/checkout/resultado?ref={data.reference}">Volver a consultar</a>
	{:else if !order}
		<h1>No encontramos tu compra en este navegador</h1>
		<p class="muted">Si ya pagaste, revisá tu email o consultá tus compras con tu documento.</p>
		<a class="button" href="/consulta">Consultar mis compras</a>
	{:else}
		{@const status = orderStatusLabel[order.status] ?? { label: order.status, tone: 'neutral' }}
		<span class="chip {status.tone}">{status.label}</span>
		{#if order.status === 'paid'}
			{@const title = '¡Listo! Tu compra está confirmada'}
			<h1 aria-label={title}><span class="hanging-punctuation" aria-hidden="true">{title[0]}</span>{title.slice(1)}</h1>
			<p class="lead">Te enviamos el comprobante y los enlaces de descarga a {order.email}.</p>
		{:else if waiting}
			<h1>Estamos esperando la confirmación de Mercado Pago</h1>
			<p class="lead muted">Si ya pagaste, suele tardar unos segundos y esta página se actualiza sola: no pagues de nuevo.</p>
			<!-- An unpaid order is never resumed: it expires on its own and a new purchase is a new order (ADR 0014 §1). -->
			<p class="muted">Si no llegaste a pagar, este pedido vence solo y no se te cobra nada. Podés hacer una compra nueva.</p>
			<a class="button" href="/tienda">Volver a la tienda</a>
		{:else if order.status === 'payment_failed'}
			<h1>El pago no se aprobó</h1>
			<p class="lead muted">No se cobró nada. Podés intentarlo de nuevo con otro medio de pago.</p>
			<a class="button" href="/tienda">Volver a la tienda</a>
		{:else if order.status === 'expired'}
			<h1>El pago no se confirmó a tiempo</h1>
			<p class="lead muted">Este pedido venció sin que nos llegara la confirmación de Mercado Pago.</p>
			<p>Si Mercado Pago te cobró, no compres de nuevo: escribinos con el comprobante {order.reference} y lo revisamos.</p>
			{#if whatsapp || contact.email}
				<div class="actions">
					{#if whatsapp}<a class="button" href={whatsapp} target="_blank" rel="noopener noreferrer">Escribinos por WhatsApp</a>{/if}
					{#if contact.email}<a class="button secondary" href="mailto:{contact.email}?subject={encodeURIComponent(`Compra ${order.reference}`)}">Escribinos por email</a>{/if}
				</div>
			{:else}
				<p class="muted">Escribinos por los canales de contacto de este sitio.</p>
			{/if}
			<p class="muted">Si no llegaste a pagar, no se te cobró nada. Podés hacer una compra nueva.</p>
			<a class="button quiet" href="/tienda">Volver a la tienda</a>
		{:else}
			<h1>Tu compra está {status.label.toLowerCase()}</h1>
		{/if}
		{#if data.unavailable}
			<p class="notice" role="status">No pudimos actualizar el estado ahora. Recargá la página en unos minutos.</p>
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
			{#if order.chances}<ChancesBadge count={order.chances.count} campaign={order.chances.campaign} lead={order.status === 'paid' ? 'Sumaste' : 'Esta compra suma'} size="line" />{/if}
			{#if order.entries.length}
				<div>
					<p><strong>Tus chances ({order.entries.length}):</strong> {order.entries.map((entry) => formatEntryNumber(entry, order.entryDigits)).join(', ')}</p>
					<p class="muted small">Cada chance es un cupón numerado en el sorteo.</p>
				</div>
			{/if}
			{#if summary}<CopySummary text={summary} />{/if}
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

	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.75rem;
	}

	.nowrap {
		white-space: nowrap;
	}
</style>
