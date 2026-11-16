<script lang="ts">
	import { untrack } from 'svelte';
	import { refreshAll } from '$app/navigation';
	import CampaignBalance from '#lib/components/admin/CampaignBalance.svelte';
	import CampaignExpenses from '#lib/components/admin/CampaignExpenses.svelte';
	import { pendingFeesNote } from '#lib/finance.js';
	import { calendarDay, campaignStatusLabel, dateTime, money, orderStatusLabel } from '#lib/format.js';
	import { connectLive, type LiveStatus } from '#lib/live.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const overview = $derived(data.overview);
	// General or one campaign, from ?campana= (odd/tasks/campaign-finance.md S1): the live refresh
	// re-reads the same URL, so it keeps the scope.
	const scoped = $derived(overview.scope.campaign);
	const canEditExpenses = $derived(data.session.permissions.includes('finance.expenses'));
	// A refusal comes back with the form; a save comes back as a fresh page with its notice (?hecho=).
	const expenseFeedback = $derived(form?.target === 'expense' ? form : data.notice ? { ok: true, message: data.notice } : null);
	const currency = $derived(data.session.organization.currency);
	const timezone = $derived(data.session.organization.timezone);
	const k = $derived(overview.kpis);
	const peak = $derived(Math.max(1, ...overview.daily.map((day) => day.totalMinor)));

	// The dashboard is a snapshot. Change notices from the live stream make it re-read
	// the whole snapshot, and so does coming back to the tab, so a dropped connection
	// never leaves stale numbers (FR-OPS-02, AC-04).
	let refreshing = $state(false);
	let live = $state<LiveStatus>('connecting');
	$effect(() => {
		const refresh = async () => {
			if (document.visibilityState !== 'visible') return;
			refreshing = true;
			await refreshAll();
			refreshing = false;
		};
		// Resume after the snapshot this page rendered; later snapshots do not reconnect.
		const after = untrack(() => data.overview.lastEventId);
		const disconnect = connectLive({
			url: `/admin/eventos?after=${after}`,
			refresh,
			onStatus: (status) => (live = status),
			isVisible: () => document.visibilityState === 'visible'
		});
		document.addEventListener('visibilitychange', refresh);
		return () => {
			disconnect();
			document.removeEventListener('visibilitychange', refresh);
		};
	});
	const liveLabel: Record<LiveStatus, string> = {
		connecting: 'Conectando…',
		live: 'En vivo',
		reconnecting: 'Reconectando…',
		polling: 'Sin conexión en vivo: se actualiza cada 30 segundos'
	};

	const cards = $derived([
		{ label: 'Ventas aprobadas', value: money(k.grossApprovedMinor, currency), note: `${k.paidOrders} órdenes pagadas` },
		{ label: 'Pagos pendientes', value: String(k.pendingOrders), note: 'Órdenes esperando a Mercado Pago' },
		{ label: 'Participantes', value: String(k.participants), note: `${k.entries} participaciones vigentes` },
		{ label: 'Premios comprometidos', value: money(k.prizesCommittedMinor, currency), note: `${money(k.prizesDeliveredMinor, currency)} entregados` },
		{ label: 'Reintegros', value: money(k.refundedMinor, currency), note: 'Reintegros y contracargos' },
		{
			label: 'Comisiones de Mercado Pago',
			value: money(k.feesMinor, currency),
			note: pendingFeesNote(k.feesPendingPayments) ?? 'Informadas por Mercado Pago'
		},
		{ label: 'Gastos', value: money(k.expensesMinor, currency), note: scoped ? 'Cargados a esta campaña' : 'De todas las campañas' },
		// S5: the same formula as the campaign balance (ADR 0025).
		{
			label: 'Neto proyectado',
			value: money(k.projectedNetMinor, currency),
			note: 'Ventas − reintegros − comisiones − premios − gastos',
			negative: k.projectedNetMinor < 0
		}
	]);
	const scopeStatus = $derived(scoped ? (campaignStatusLabel[scoped.status] ?? { label: scoped.status, tone: 'neutral' }) : null);
</script>

<svelte:head>
	<title>Resumen | Panel</title>
</svelte:head>

<header class="head">
	<div class="title">
		<h1>Resumen</h1>
		<p class="scope-name" data-testid="overview-scope">
			{#if scoped}
				<span>Campaña: <strong>{scoped.title}</strong></span>
				{#if scopeStatus}<span class="chip {scopeStatus.tone}">{scopeStatus.label}</span>{/if}
			{:else}
				<span>General: toda la organización</span>
			{/if}
		</p>
	</div>
	<p class="muted small status" aria-live="polite">
		<span class="indicator {live}" data-testid="live-status">{liveLabel[live]}</span>
		<span>{refreshing ? 'Actualizando…' : `Actualizado ${dateTime(overview.generatedAt, timezone)}`}</span>
	</p>
</header>

<!-- S1: a GET form, so the scope is a link: reload and back keep it, and it works without JavaScript. -->
<form class="scope" method="GET" action="/admin">
	<div class="field">
		<label for="scope">Ver el resumen de</label>
		<select id="scope" name="campana">
			<option value="" selected={!scoped}>General</option>
			{#each overview.campaigns as option (option.id)}
				<option value={option.id} selected={scoped?.id === option.id}>{option.title}</option>
			{/each}
		</select>
	</div>
	<button class="button small secondary">Ver</button>
</form>

{#if data.scopeError}<p class="notice error" role="alert">{data.scopeError}</p>{/if}

{#if overview.alerts.length}
	<div class="alerts">
		{#each overview.alerts as alert (alert.kind)}
			<p class="notice error"><strong>{alert.count}</strong> {alert.message}</p>
		{/each}
	</div>
{/if}

<section class="cards" aria-label="Indicadores">
	{#each cards as card (card.label)}
		<article class="panel card">
			<p class="muted small">{card.label}</p>
			<p class="value" class:negative={card.negative}>{card.value}</p>
			<p class="muted small">{card.note}</p>
		</article>
	{/each}
</section>

{#if scoped && overview.balance && data.expenses}
	<div class="finance">
		<CampaignBalance balance={overview.balance} {currency} />
		<CampaignExpenses
			campaignId={scoped.id}
			expenses={data.expenses.expenses}
			totalMinor={data.expenses.totalMinor}
			{currency}
			canEdit={canEditExpenses}
			editing={data.editing}
			removing={data.removing}
			today={data.today}
			feedback={expenseFeedback}
		/>
	</div>
{/if}

<div class="grid">
	<section class="panel" aria-labelledby="chart-title">
		<h2 id="chart-title">Ventas de los últimos 14 días</h2>
		<svg class="chart" viewBox="0 0 700 220" role="img" aria-label="Ventas diarias de los últimos 14 días">
			{#each overview.daily as day, index (day.day)}
				{@const height = Math.max(2, (day.totalMinor / peak) * 170)}
				<g>
					<title>{calendarDay(day.day)}: {money(day.totalMinor, currency)}, {day.orders} órdenes</title>
					<rect x={index * 50 + 8} y={190 - height} width="34" height={height} rx="4" class:today={index === overview.daily.length - 1} />
					<text x={index * 50 + 25} y="212" text-anchor="middle">{day.day.slice(8)}</text>
				</g>
			{/each}
		</svg>
	</section>

	<section class="panel" aria-labelledby="recent-title">
		<h2 id="recent-title">Actividad reciente</h2>
		{#if overview.recent.length === 0}
			<p class="muted">Todavía no hay órdenes.</p>
		{:else}
			<ul class="recent">
				{#each overview.recent as order (order.reference)}
					{@const status = orderStatusLabel[order.status] ?? { label: order.status, tone: 'neutral' }}
					<li>
						<div>
							<p class="ref">{order.reference}</p>
							<p class="muted small">{order.buyer}, {dateTime(order.updatedAt, timezone)}</p>
						</div>
						<span class="chip {status.tone}">{status.label}</span>
						<span class="money">{money(order.totalMinor, currency)}</span>
					</li>
				{/each}
			</ul>
		{/if}
	</section>
</div>

<style>
	.status {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem 1rem;
		align-items: center;
	}

	.indicator {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		font-weight: 600;
	}

	.indicator::before {
		content: '';
		width: 0.55rem;
		height: 0.55rem;
		border-radius: 50%;
		background: var(--muted);
	}

	.indicator.live::before {
		background: var(--success);
	}

	.indicator.reconnecting::before,
	.indicator.polling::before {
		background: var(--warning);
	}

	.head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		flex-wrap: wrap;
		gap: 0.5rem 1rem;
		margin-bottom: 1.5rem;
	}

	h1 {
		font-size: var(--step-4);
		text-transform: uppercase;
	}

	h2 {
		font-size: var(--step-1);
		text-transform: uppercase;
		margin-bottom: 1rem;
	}

	.small {
		font-size: var(--step--1);
	}

	.alerts {
		display: grid;
		gap: 0.5rem;
		margin-bottom: 1.25rem;
	}

	.title {
		display: grid;
		gap: 0.35rem;
	}

	.scope-name {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem 0.75rem;
		align-items: center;
	}

	.scope {
		display: flex;
		flex-wrap: wrap;
		gap: 0.6rem;
		align-items: end;
		margin-bottom: 1.25rem;
	}

	.scope .field {
		flex: 0 1 26rem;
		min-width: 0;
	}

	.cards {
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		gap: 1rem;
		margin-bottom: 1rem;
	}

	.value.negative {
		color: var(--danger);
	}

	.finance {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr);
		gap: 1rem;
		align-items: start;
		margin-bottom: 1rem;
	}

	.card {
		display: grid;
		gap: 0.35rem;
	}

	/* Four cards a row: a large amount, sign included, stays on one line. */
	.value {
		font: 800 var(--step-2) / 1.05 var(--font-display);
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}

	.grid {
		display: grid;
		grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr);
		gap: 1rem;
	}

	.chart {
		width: 100%;
		height: auto;
	}

	.chart rect {
		fill: color-mix(in srgb, var(--accent) 45%, var(--surface-2));
	}

	.chart rect.today {
		fill: var(--accent);
	}

	.chart text {
		fill: var(--muted);
		font-size: 12px;
	}

	.recent {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.recent li {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto auto;
		gap: 0.75rem;
		align-items: center;
		padding-block: 0.7rem;
		border-bottom: 1px solid var(--border);
	}

	.ref {
		font-weight: 700;
	}

	@media (max-width: 1100px) {
		.grid,
		.finance {
			grid-template-columns: 1fr;
		}

		.cards {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}

	@media (max-width: 760px) {
		.cards {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}
</style>
