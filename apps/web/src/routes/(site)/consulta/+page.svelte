<script lang="ts">
	import { dateTime, money, orderStatusLabel } from '#lib/format.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const timezone = $derived(data.site?.organization.timezone ?? 'America/Argentina/Buenos_Aires');
	const verifying = $derived(form?.step === 'verify');
</script>

<svelte:head>
	<title>Consultar mis compras | {data.site?.organization.name}</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<section class="container page">
	<h1>Consultar mis compras</h1>

	{#if data.result}
		<div class="head">
			<p class="lead">Hola{data.result.holder.firstName ? `, ${data.result.holder.firstName}` : ''}. {data.result.holder.scope === 'order' ? 'Estás viendo la compra del comprobante que ingresaste.' : 'Estas son tus compras.'}</p>
			<form method="POST" action="?/logout"><button class="button secondary small">Cerrar consulta</button></form>
		</div>
		{#if form?.message}<p class="notice error" role="alert">{form.message}</p>{/if}

		{#if data.result.campaigns.length}
			<section aria-labelledby="entries-title" class="block">
				<h2 id="entries-title">Tus participaciones</h2>
				{#each data.result.campaigns as campaign (campaign.slug)}
					<article class="panel">
						<h3><a href="/sorteos/{campaign.slug}">{campaign.title}</a></h3>
						<p class="muted small">{campaign.entries.filter((entry) => entry.status === 'eligible').length} vigentes. Los números se asignan al confirmarse el pago y no cambian.</p>
						<ul class="entries">
							{#each campaign.entries as entry (entry.number)}
								<li class:void={entry.status === 'void'} title={entry.status === 'void' ? 'Anulada por reintegro' : 'Vigente'}>#{entry.number}</li>
							{/each}
						</ul>
					</article>
				{/each}
			</section>
		{/if}

		<section aria-labelledby="orders-title" class="block">
			<h2 id="orders-title">Compras</h2>
			{#if data.result.orders.length === 0}
				<p class="muted">No hay compras para mostrar.</p>
			{/if}
			{#each data.result.orders as order (order.id)}
				{@const status = orderStatusLabel[order.status] ?? { label: order.status, tone: 'neutral' }}
				<article class="panel order">
					<div class="order-head">
						<div>
							<p class="code">{order.reference}</p>
							<p class="muted small">{dateTime(order.createdAt, timezone)}</p>
						</div>
						<span class="chip {status.tone}">{status.label}</span>
						<span class="money">{money(order.totalMinor, order.currency)}</span>
					</div>
					<ul class="items">
						{#each order.items as item (item.name)}
							<li>{item.name} × {item.quantity}</li>
						{/each}
					</ul>
					{#if order.downloads.length}
						<div class="downloads">
							{#each order.downloads as download (download.assetId)}
								<form method="POST" action="?/download">
									<input type="hidden" name="orderId" value={order.id} />
									<input type="hidden" name="assetId" value={download.assetId} />
									<button class="button small">Descargar {download.filename}</button>
								</form>
							{/each}
						</div>
					{/if}
				</article>
			{/each}
		</section>
	{:else}
		<p class="lead muted">Por tu seguridad, primero verificamos que seas vos. Nadie puede ver tus compras solo con tu número de documento.</p>
		{#if data.expired}<p class="notice">Tu consulta venció. Verificá de nuevo para continuar.</p>{/if}
		{#if form?.message && !verifying}<p class="notice error" role="alert">{form.message}</p>{/if}

		<div class="ways">
			<div class="panel">
				{#if verifying}
					<h2>Ingresá el código</h2>
					{#if form && 'error' in form && form.error}
						<p class="notice error" role="alert">{form.error}</p>
					{:else}
						<p class="notice ok" role="status">{form?.message}</p>
					{/if}
					<form method="POST" action="?/verify" class="stack">
						<input type="hidden" name="challengeId" value={form?.challengeId} />
						<div class="field">
							<label for="code">Código de 6 dígitos</label>
							<input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern={'[0-9]{6}'} maxlength="6" required />
						</div>
						<button class="button">Ver mis compras</button>
					</form>
					<a class="button quiet small" href="/consulta">Usar otro documento</a>
				{:else}
					<h2>Con tu documento</h2>
					<p class="muted small">Te enviamos un código al email que usaste al comprar.</p>
					<form method="POST" action="?/start" class="stack">
						<div class="row">
							<div class="field">
								<label for="documentType">Tipo</label>
								<select id="documentType" name="documentType">
									<option value="DNI">DNI</option>
									<option value="CUIT">CUIT</option>
									<option value="PASSPORT">Pasaporte</option>
								</select>
							</div>
							<div class="field">
								<label for="documentNumber">Número</label>
								<input id="documentNumber" name="documentNumber" inputmode="numeric" required />
							</div>
						</div>
						<button class="button">Enviarme un código</button>
					</form>
				{/if}
			</div>

			<div class="panel">
				<h2>Con tu comprobante</h2>
				<p class="muted small">El comprobante y el código de acceso aparecen al terminar la compra.</p>
				{#if form?.step === 'receipt' && form.message}<p class="notice error" role="alert">{form.message}</p>{/if}
				<form method="POST" action="?/receipt" class="stack">
					<div class="field">
						<label for="reference">Comprobante</label>
						<input id="reference" name="reference" placeholder="MG-XXXXXXXX" autocapitalize="characters" required />
					</div>
					<div class="field">
						<label for="accessCode">Código de acceso</label>
						<input id="accessCode" name="accessCode" autocapitalize="characters" autocomplete="off" required />
					</div>
					<button class="button secondary">Ver esta compra</button>
				</form>
			</div>
		</div>
	{/if}
</section>

<style>
	.page {
		padding-top: clamp(2.5rem, 2rem + 3vw, 5rem);
		display: grid;
		gap: 1.25rem;
	}

	h1 {
		font-size: var(--step-4);
		text-transform: uppercase;
	}

	h2 {
		font-size: var(--step-2);
		text-transform: uppercase;
		margin-bottom: 0.5rem;
	}

	h3 {
		font-size: var(--step-2);
		text-transform: uppercase;
	}

	.lead {
		font-size: var(--step-1);
		max-width: 60ch;
	}

	.head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		flex-wrap: wrap;
	}

	.ways {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 1.25rem;
		align-items: start;
	}

	.panel {
		display: grid;
		gap: 0.9rem;
	}

	.stack {
		display: grid;
		gap: 1rem;
	}

	.row {
		display: grid;
		grid-template-columns: 140px 1fr;
		gap: 0.75rem;
	}

	.block {
		display: grid;
		gap: 1rem;
		margin-top: 1rem;
	}

	.entries {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}

	.entries li {
		padding: 0.35rem 0.75rem;
		border: 1px solid var(--accent);
		border-radius: var(--radius-sm);
		font: 800 var(--step-1) / 1 var(--font-display);
	}

	.entries li.void {
		border-color: var(--border);
		color: var(--muted);
		text-decoration: line-through;
	}

	.order-head {
		display: grid;
		grid-template-columns: 1fr auto auto;
		gap: 1rem;
		align-items: center;
	}

	.code {
		font: 800 var(--step-2) / 1 var(--font-display);
	}

	.items {
		margin: 0;
		padding-left: 1.1rem;
		color: var(--muted);
	}

	.downloads {
		display: flex;
		flex-wrap: wrap;
		gap: 0.6rem;
	}

	.small {
		font-size: var(--step--1);
	}

	@media (max-width: 820px) {
		.ways {
			grid-template-columns: 1fr;
		}

		.order-head {
			grid-template-columns: 1fr auto;
		}
	}
</style>
