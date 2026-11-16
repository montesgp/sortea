<script lang="ts">
	import { formatEntryNumber } from '@sortea/domain';
	import { dateTime, money, orderStatusLabel } from '#lib/format.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const order = $derived(data.order);
	// "Reenviar la compra" (odd/tasks/checkout-two-steps.md S5): the API checks the permission again.
	const canResend = $derived(data.session.permissions.includes('orders.resend'));
	const resendForm = $derived(form && 'action' in form && form.action === 'resend' ? form : null);
	const confirming = $derived(resendForm && 'confirm' in resendForm ? resendForm : null);
	const resendError = $derived(resendForm && 'message' in resendForm ? resendForm.message : null);
	const typedEmail = $derived(resendForm && 'email' in resendForm ? resendForm.email : '');
	const timezone = $derived(data.session.organization.timezone);
	const status = $derived(orderStatusLabel[order.status] ?? { label: order.status, tone: 'neutral' as const });
	const consentLabel: Record<string, string> = {
		terms: 'Términos de venta',
		privacy: 'Política de privacidad',
		marketing_email: 'Novedades por email',
		// Recorded only before owner-feedback-2026-11-14 S3: winners are always published by name and city now.
		winner_publicity: 'Publicar identidad si gana (registro anterior, ya no se aplica)',
		adult_declaration: 'Declaración de mayoría de edad'
	};
</script>

<svelte:head>
	<title>{order.reference} | Panel</title>
</svelte:head>

<a class="small" href="/admin/pedidos">Volver a pedidos</a>
<header class="head">
	<h1>{order.reference}</h1>
	<span class="chip {status.tone}">{status.label}</span>
</header>

<div class="grid">
	<section class="panel">
		<h2>Comprador</h2>
		{#if !order.piiVisible}<p class="muted small">Datos enmascarados para tu rol.</p>{/if}
		<dl>
			<div><dt>Nombre</dt><dd>{order.buyer.firstName} {order.buyer.lastName}</dd></div>
			<div><dt>Documento</dt><dd>{order.buyer.document ?? '—'}</dd></div>
			<div><dt>Email</dt><dd>{order.buyer.email}</dd></div>
			{#if order.buyer.phone}<div><dt>Teléfono</dt><dd>{order.buyer.phone}</dd></div>{/if}
			{#if order.buyer.province}<div><dt>Ubicación</dt><dd>{order.buyer.city ? `${order.buyer.city}, ` : ''}{order.buyer.province}</dd></div>{/if}
			{#if order.buyer.address}
				<!-- Named keys: jsonb does not keep the order the address was written in. -->
				{@const address = order.buyer.address}
				<div><dt>Envío</dt><dd>{[address.street, address.city, address.province, address.postalCode].filter(Boolean).join(', ')}</dd></div>
			{/if}
		</dl>
		{#if order.piiVisible}<p class="muted small">Esta consulta quedó registrada en la auditoría.</p>{/if}
	</section>

	{#if canResend}
		<section class="panel" id="reenviar">
			<h2>Reenviar la compra</h2>
			{#if data.resent}<p class="notice ok" role="status">Listo: el email de la compra sale en unos minutos, con el comprobante, las descargas y los cupones.</p>{/if}
			{#if resendError}<p class="notice error" role="alert">{resendError}</p>{/if}
			{#if !order.resendable}
				<p class="muted">Esta compra no tiene un email de compra para reenviar: solo se reenvían las compras pagadas.</p>
			{:else if confirming}
				<form method="POST" action="?/resend" class="stack">
					<input type="hidden" name="confirm" value="yes" />
					<input type="hidden" name="requestId" value={confirming.requestId} />
					{#if confirming.email}<input type="hidden" name="email" value={confirming.email} />{/if}
					<p>Vas a enviar el comprobante, las descargas y los cupones a <strong>{confirming.email || order.buyer.email}</strong>. ¿Seguimos?</p>
					{#if confirming.email}<p class="muted small">El email cambia solo en este pedido.</p>{/if}
					<div class="actions">
						<button class="button small">Sí, enviar</button>
						<a class="button small secondary" href="/admin/pedidos/{order.id}">Cancelar</a>
					</div>
				</form>
			{:else}
				<p class="small">Email actual: <strong>{order.buyer.email}</strong></p>
				<form method="POST" action="?/resend" class="stack">
					<div class="field">
						<label for="resend-email">Corregir el email <span class="muted">(opcional)</span></label>
						<input id="resend-email" type="email" name="email" inputmode="email" autocomplete="off" maxlength="160" value={typedEmail} aria-describedby="resend-email-help" />
						<p class="muted small" id="resend-email-help">Si quien compró lo escribió mal, confirmá el correcto por teléfono antes de cambiarlo. Vacío, se reenvía al email actual.</p>
					</div>
					<div class="actions"><button class="button small secondary">Reenviar la compra</button></div>
				</form>
			{/if}
		</section>
	{/if}

	<section class="panel">
		<h2>Importe</h2>
		<ul class="lines">
			{#each order.items as item (item.name)}
				<li><span>{item.name} × {item.quantity}</span><span class="money">{money(item.lineTotalMinor, order.currency)}</span></li>
			{/each}
			{#if order.deliveryFeeMinor}<li><span>Envío</span><span class="money">{money(order.deliveryFeeMinor, order.currency)}</span></li>{/if}
			<li class="total"><span>Total</span><span class="money">{money(order.totalMinor, order.currency)}</span></li>
		</ul>
		<p class="muted small">Creada {dateTime(order.createdAt, timezone)}{order.paidAt ? `, pagada ${dateTime(order.paidAt, timezone)}` : ''}.</p>
	</section>

	<section class="panel">
		<h2>Pagos de Mercado Pago</h2>
		{#if order.payments.length === 0}
			<p class="muted">Todavía no llegó ninguna notificación de pago.</p>
		{:else}
			<ul class="lines">
				{#each order.payments as payment (payment.providerPaymentId)}
					<li>
						<span><span class="payment-id" title={payment.providerPaymentId}>#{payment.providerPaymentId}</span> <span class="muted small">{payment.status}{payment.statusDetail ? ` (${payment.statusDetail})` : ''}</span></span>
						<span class="money">{money(payment.amountMinor, order.currency)}</span>
					</li>
				{/each}
			</ul>
		{/if}
	</section>

	<section class="panel">
		<h2>Participaciones</h2>
		{#if order.entries.length === 0}
			<p class="muted">Esta compra no generó participaciones.</p>
		{:else}
			<p>
				{#if order.campaignTitle}<strong>Cupones de {order.campaignTitle} ({order.entries.length}):</strong>{/if}
				{order.entries.map((entry) => `${formatEntryNumber(entry.number, order.entryDigits)}${entry.status === 'void' ? ' (anulada)' : ''}`).join(', ')}
			</p>
		{/if}
		<h2 class="spaced">Consentimientos</h2>
		<ul class="lines">
			{#each order.consents as consent (consent.purpose)}
				<li><span>{consentLabel[consent.purpose] ?? consent.purpose}</span><span class="chip {consent.granted ? 'ok' : 'neutral'}">{consent.granted ? 'Otorgado' : 'No otorgado'}</span></li>
			{/each}
		</ul>
	</section>
</div>

<style>
	.head {
		display: flex;
		align-items: center;
		gap: 1rem;
		margin: 0.75rem 0 1.5rem;
	}

	h1 {
		font-size: var(--step-4);
	}

	h2 {
		font-size: var(--step-1);
		text-transform: uppercase;
		margin-bottom: 0.75rem;
	}

	.spaced {
		margin-top: 1.5rem;
	}

	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(320px, 100%), 1fr));
		gap: 1rem;
	}

	/* A card never grows past its track: long ids wrap inside it (S4). */
	.grid > .panel {
		min-width: 0;
	}

	dl {
		margin: 0;
		display: grid;
		gap: 0.6rem;
	}

	dt {
		font-size: var(--step--1);
		color: var(--muted);
	}

	dd {
		margin: 0;
		font-weight: 600;
		overflow-wrap: anywhere;
	}

	.lines {
		list-style: none;
		margin: 0 0 0.75rem;
		padding: 0;
		display: grid;
		gap: 0.5rem;
	}

	.lines li {
		display: flex;
		justify-content: space-between;
		gap: 1rem;
	}

	.lines li > :first-child {
		min-width: 0;
		overflow-wrap: anywhere;
	}

	/* Amounts and chips keep their width; the text beside them wraps instead. */
	.lines li > :last-child {
		flex-shrink: 0;
		white-space: nowrap;
	}

	.total {
		border-top: 1px solid var(--border);
		padding-top: 0.5rem;
		font-weight: 800;
	}

	.small {
		font-size: var(--step--1);
	}

	.stack {
		display: grid;
		gap: 0.75rem;
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}
</style>
