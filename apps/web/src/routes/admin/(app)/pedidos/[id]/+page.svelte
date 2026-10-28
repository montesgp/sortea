<script lang="ts">
	import { formatEntryNumber } from '@sortea/domain';
	import { dateTime, money, orderStatusLabel } from '#lib/format.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const order = $derived(data.order);
	const timezone = $derived(data.session.organization.timezone);
	const status = $derived(orderStatusLabel[order.status] ?? { label: order.status, tone: 'neutral' as const });
	const consentLabel: Record<string, string> = { terms: 'Términos de venta', privacy: 'Política de privacidad', marketing_email: 'Novedades por email', winner_publicity: 'Publicar identidad si gana', adult_declaration: 'Declaración de mayoría de edad' };
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

	<section class="panel">
		<h2>Importe</h2>
		<ul class="lines">
			{#each order.items as item (item.name)}
				<li><span>{item.name} × {item.quantity}</span><span class="money">{money(item.lineTotalMinor, order.currency)}</span></li>
			{/each}
			{#if order.deliveryFeeMinor}<li><span>Envío</span><span class="money">{money(order.deliveryFeeMinor, order.currency)}</span></li>{/if}
			<li class="total"><span>Total</span><span class="money">{money(order.totalMinor, order.currency)}</span></li>
		</ul>
		<p class="muted small">Creada {dateTime(order.createdAt, timezone, 'short')}{order.paidAt ? `, pagada ${dateTime(order.paidAt, timezone, 'short')}` : ''}.</p>
	</section>

	<section class="panel">
		<h2>Pagos de Mercado Pago</h2>
		{#if order.payments.length === 0}
			<p class="muted">Todavía no llegó ninguna notificación de pago.</p>
		{:else}
			<ul class="lines">
				{#each order.payments as payment (payment.providerPaymentId)}
					<li>
						<span>#{payment.providerPaymentId} <span class="muted small">{payment.status}{payment.statusDetail ? ` (${payment.statusDetail})` : ''}</span></span>
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
			<p>{order.entries.map((entry) => `${formatEntryNumber(entry.number, order.entryDigits)}${entry.status === 'void' ? ' (anulada)' : ''}`).join(', ')}</p>
		{/if}
		<h2 class="spaced">Consentimientos</h2>
		<ul class="lines">
			{#each order.consents as consent (consent.purpose)}
				<li><span>{consentLabel[consent.purpose] ?? consent.purpose}</span><span class="chip {consent.granted ? 'ok' : 'neutral'}">{consent.granted ? 'Otorgado' : 'No otorgado'}</span></li>
			{/each}
		</ul>
		{#if order.winnerPublicity}
			{@const publicity = order.winnerPublicity}
			<p class="small">
				{publicity.publishable ? 'Si un cupón de esta compra gana, se publican nombre, ciudad y chances.' : 'Si un cupón de esta compra gana, no se publica su identidad.'}
				{#if publicity.withdrawnAt}La persona retiró la autorización el {dateTime(publicity.withdrawnAt, timezone, 'short')}.{/if}
			</p>
			{#if form?.message}<p class="notice {form.ok ? 'ok' : 'error'}" role={form.ok ? 'status' : 'alert'}>{form.message}</p>{/if}
			{#if order.piiVisible && publicity.withdrawable}
				<form method="POST" action="?/withdrawPublicity" class="withdraw">
					<h3>Retirar autorización de publicar identidad</h3>
					<p class="small muted">Para cuando la persona lo pide por escrito. Vale para todas las compras de esta persona hechas hasta hoy; una compra posterior en la que marque la casilla vuelve a autorizar solo esa compra. Queda registrado en la auditoría.</p>
					<label class="check small"><input type="checkbox" name="confirm" value="yes" required /> La persona pidió que no publiquemos su identidad si gana</label>
					<button class="button small secondary danger">Retirar autorización de publicar identidad</button>
				</form>
			{/if}
		{/if}
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

	.withdraw {
		display: grid;
		gap: 0.6rem;
		margin-top: 1rem;
		padding-top: 0.9rem;
		border-top: 1px solid var(--border);
	}

	.withdraw h3 {
		font-size: var(--step-0);
	}

	.withdraw .danger {
		justify-self: start;
		color: var(--danger);
		border-color: var(--danger);
	}

	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
		gap: 1rem;
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

	.total {
		border-top: 1px solid var(--border);
		padding-top: 0.5rem;
		font-weight: 800;
	}

	.small {
		font-size: var(--step--1);
	}
</style>
