<script lang="ts">
	import { dateTime, money } from '#lib/format.js';
	import { describeDiscrepancy, discrepancyLabel, resolutionLabel } from '#lib/reconciliation.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const overview = $derived(data.overview);
	const finance = $derived(overview.finance);
	const currency = $derived(overview.currency);
	const timezone = $derived(data.session.organization.timezone);
	const list = $derived(data.list);
	const pages = $derived(Math.max(1, Math.ceil(list.total / list.pageSize)));
	const resolvedView = $derived(data.filters.estado === 'resolved');
	const feedback = $derived(form?.action ? form : null);

	const cards = $derived([
		{ label: 'Bruto aprobado', value: money(finance.grossMinor, currency), note: `${finance.payments} pagos aprobados` },
		{
			label: 'Comisiones',
			value: money(finance.feesMinor, currency),
			note: finance.feesUnknown ? `${finance.feesUnknown} pagos sin dato de comisión` : 'Informadas por Mercado Pago'
		},
		{ label: 'Reintegros y contracargos', value: money(finance.reversedMinor, currency), note: 'Dinero devuelto a compradores' },
		{
			label: 'Neto estimado',
			value: money(finance.netEstimatedMinor, currency),
			note: finance.netUnknown ? `Falta el dato en ${finance.netUnknown} pagos` : 'Según Mercado Pago, antes de liquidar'
		},
		{
			label: 'Acreditado',
			value: money(finance.creditedMinor, currency),
			note: finance.settlementMovements ? `${finance.settlementMovements} movimientos de reportes de liquidación` : 'Subí un reporte de liquidaciones para verlo'
		},
		{ label: 'Disponible y retiros', value: 'Sin dato', note: 'Solo Mercado Pago puede informarlo; no se deduce de las ventas' }
	]);

	const runKind = { operations: 'Operaciones', settlements: 'Liquidaciones' } as const;
	const runTrigger = { scheduled: 'Programada', manual: 'Manual', upload: 'Reporte subido' } as const;
	const runStatus = {
		running: { label: 'En curso', tone: 'warn' },
		completed: { label: 'Completa', tone: 'ok' },
		failed: { label: 'Falló', tone: 'bad' }
	} as const;

	const pageLink = (page: number) => {
		const params = new URLSearchParams();
		if (resolvedView) params.set('estado', 'resueltas');
		if (data.filters.tipo) params.set('tipo', data.filters.tipo);
		if (data.filters.desde) params.set('desde', data.filters.desde);
		if (data.filters.hasta) params.set('hasta', data.filters.hasta);
		params.set('pagina', String(page));
		return `?${params}`;
	};
	const exportLink = (source: string) => `/admin/conciliacion/exportar/${source}${data.exportQuery ? `?${data.exportQuery}` : ''}`;
</script>

<svelte:head>
	<title>Conciliación | Panel</title>
</svelte:head>

<header class="head">
	<div>
		<h1>Conciliación</h1>
		<p class="muted small">Compara lo que registró la plataforma con lo que informa Mercado Pago. Cada diferencia la resuelve una persona y queda en la auditoría.</p>
	</div>
	<div class="chips" aria-label="Diferencias abiertas">
		<span class="chip {overview.open.critical ? 'bad' : 'ok'}">{overview.open.critical} críticas</span>
		<span class="chip {overview.open.warning ? 'warn' : 'neutral'}">{overview.open.warning} advertencias</span>
	</div>
</header>

{#if feedback}
	<p class="notice {feedback.ok ? 'ok' : 'error'}" role={feedback.ok ? 'status' : 'alert'}>{feedback.message}</p>
{/if}

<section class="panel" aria-labelledby="money-title">
	<div class="section-head">
		<h2 id="money-title">Dinero</h2>
		<form class="period" method="GET">
			<input type="hidden" name="estado" value={resolvedView ? 'resueltas' : ''} />
			<input type="hidden" name="tipo" value={data.filters.tipo} />
			<div class="field">
				<label for="desde">Desde</label>
				<input id="desde" name="desde" type="date" defaultValue={data.filters.desde} />
			</div>
			<div class="field">
				<label for="hasta">Hasta</label>
				<input id="hasta" name="hasta" type="date" defaultValue={data.filters.hasta} />
			</div>
			<button class="button secondary">Ver período</button>
		</form>
	</div>
	<p class="muted small">
		{data.filters.desde || data.filters.hasta ? 'Pagos aprobados en el período elegido.' : 'Todos los pagos aprobados.'} Los montos vienen de Mercado Pago; ninguno se calcula a partir
		de las ventas.
	</p>
	<div class="cards">
		{#each cards as card (card.label)}
			<article class="card">
				<p class="muted small">{card.label}</p>
				<p class="value">{card.value}</p>
				<p class="muted small">{card.note}</p>
			</article>
		{/each}
	</div>
	<div class="exports">
		<span class="small">Exportar CSV{data.exportQuery ? ' del período' : ' de los últimos 30 días'}:</span>
		<a class="button quiet small" href={exportLink('system')}>Plataforma</a>
		<a class="button quiet small" href={exportLink('provider')}>Mercado Pago</a>
		<a class="button quiet small" href={exportLink('settlements')}>Liquidaciones</a>
		<a class="button quiet small" href={exportLink('items')}>Diferencias</a>
	</div>
</section>

{#if overview.canReconcile}
	<div class="grid">
		<section class="panel" aria-labelledby="run-title">
			<h2 id="run-title">Conciliar operaciones</h2>
			<p class="muted small">
				Se ejecuta sola cada media hora. Revisa los pagos que cambiaron en Mercado Pago desde la última vez y vuelve a leer los que la plataforma tocó o que tienen
				diferencias abiertas.
			</p>
			<form method="POST" action="?/run">
				<button class="button small">Conciliar ahora</button>
			</form>
		</section>

		<section class="panel" aria-labelledby="upload-title">
			<h2 id="upload-title">Reporte de liquidaciones</h2>
			<p class="muted small">
				Subí el reporte de dinero en cuenta de Mercado Pago (CSV con encabezados en inglés, hasta 480 KB). Subir el mismo reporte dos veces no duplica movimientos.
			</p>
			<form method="POST" action="?/upload" enctype="multipart/form-data" class="upload">
				<div class="field">
					<label for="report">Archivo CSV</label>
					<input id="report" name="report" type="file" accept=".csv,text/csv" required />
				</div>
				<button class="button small secondary">Subir y comparar</button>
			</form>
		</section>
	</div>
{/if}

<section class="panel" aria-labelledby="items-title">
	<div class="section-head">
		<h2 id="items-title">Diferencias</h2>
		<form class="filters" method="GET">
			<input type="hidden" name="desde" value={data.filters.desde} />
			<input type="hidden" name="hasta" value={data.filters.hasta} />
			<div class="field">
				<label for="estado">Estado</label>
				<select id="estado" name="estado">
					<option value="" selected={!resolvedView}>Abiertas</option>
					<option value="resueltas" selected={resolvedView}>Resueltas</option>
				</select>
			</div>
			<div class="field">
				<label for="tipo">Tipo</label>
				<select id="tipo" name="tipo">
					<option value="">Todos</option>
					{#each Object.entries(discrepancyLabel) as [value, label] (value)}
						<option {value} selected={data.filters.tipo === value}>{label}</option>
					{/each}
				</select>
			</div>
			<button class="button secondary">Filtrar</button>
		</form>
	</div>

	<div class="table-wrap">
		<table>
			<thead>
				<tr>
					<th scope="col">Diferencia</th>
					<th scope="col">Orden y pago</th>
					<th scope="col">Detectada</th>
					<th scope="col">{resolvedView ? 'Resolución' : 'Acciones'}</th>
				</tr>
			</thead>
			<tbody>
				{#each list.items as item (item.id)}
					<tr>
						<td class="what">
							<span class="chip {item.severity === 'critical' ? 'bad' : 'warn'}">{item.severity === 'critical' ? 'Crítica' : 'Advertencia'}</span>
							<strong>{discrepancyLabel[item.kind] ?? item.kind}</strong>
							<span class="small">{describeDiscrepancy(item.kind, item.expected, item.observed, currency)}</span>
						</td>
						<td class="small">
							{#if item.orderId}<a href="/admin/pedidos/{item.orderId}">{item.orderReference}</a>{:else}{item.orderReference ?? 'Sin orden'}{/if}
							{#if item.providerPaymentId}<br /><span class="muted">Pago {item.providerPaymentId}</span>{/if}
						</td>
						<td class="small">
							{dateTime(item.firstSeenAt, timezone, 'short')}
							{#if item.lastSeenAt !== item.firstSeenAt}<br /><span class="muted">Última vez {dateTime(item.lastSeenAt, timezone, 'short')}</span>{/if}
						</td>
						<td class="actions">
							{#if item.status === 'resolved'}
								<span class="small">{resolutionLabel[item.resolution ?? ''] ?? item.resolution}</span>
								{#if item.resolutionNote}<span class="muted small">{item.resolutionNote}</span>{/if}
								{#if item.resolvedAt}<span class="muted small">{dateTime(item.resolvedAt, timezone, 'short')}</span>{/if}
							{:else if overview.canReconcile}
								{#if item.canApplyProviderState}
									<form method="POST" action="?/apply">
										<input type="hidden" name="itemId" value={item.id} />
										<button class="button small">Aplicar estado de Mercado Pago</button>
									</form>
								{/if}
								<details>
									<summary class="small">Aceptar con explicación</summary>
									<form method="POST" action="?/accept" class="accept">
										<input type="hidden" name="itemId" value={item.id} />
										<div class="field">
											<label for="note-{item.id}">Por qué se acepta</label>
											<textarea id="note-{item.id}" name="note" rows="3" minlength="10" maxlength="1000" required></textarea>
										</div>
										<button class="button secondary small">Aceptar diferencia</button>
									</form>
								</details>
							{:else}
								<span class="muted small">Pendiente de Finanzas</span>
							{/if}
						</td>
					</tr>
				{:else}
					<tr><td colspan="4" class="muted">{resolvedView ? 'Todavía no hay diferencias resueltas.' : 'No hay diferencias abiertas.'}</td></tr>
				{/each}
			</tbody>
		</table>
	</div>

	{#if pages > 1}
		<nav class="pager" aria-label="Páginas">
			{#if list.page > 1}<a class="button secondary small" href={pageLink(list.page - 1)}>Anterior</a>{/if}
			<span class="muted small">Página {list.page} de {pages}</span>
			{#if list.page < pages}<a class="button secondary small" href={pageLink(list.page + 1)}>Siguiente</a>{/if}
		</nav>
	{/if}
</section>

<section class="panel" aria-labelledby="runs-title">
	<h2 id="runs-title">Últimas ejecuciones</h2>
	<div class="table-wrap">
		<table>
			<thead>
				<tr>
					<th scope="col">Inicio</th>
					<th scope="col">Tipo</th>
					<th scope="col">Período revisado</th>
					<th scope="col">Estado</th>
					<th scope="col">Resultado</th>
				</tr>
			</thead>
			<tbody>
				{#each overview.runs as run (run.id)}
					{@const status = runStatus[run.status]}
					<tr>
						<td class="small">{dateTime(run.startedAt, timezone, 'short')}</td>
						<td class="small">{runKind[run.kind]}<br /><span class="muted">{runTrigger[run.trigger]}</span></td>
						<td class="small">{dateTime(run.windowFrom, timezone, 'short')} a {dateTime(run.windowTo, timezone, 'short')}</td>
						<td><span class="chip {status.tone}">{status.label}</span></td>
						<td class="small">
							{#if run.error}
								{run.error}
							{:else if run.summary.file}
								{run.summary.file.name}: {run.summary.file.rows} movimientos, {run.summary.discrepancies ?? 0} diferencias
							{:else if run.status === 'completed'}
								{run.summary.examined ?? 0} pagos, {run.summary.discrepancies ?? 0} diferencias{run.summary.cleared ? `, ${run.summary.cleared} resueltas solas` : ''}
							{/if}
						</td>
					</tr>
				{:else}
					<tr><td colspan="5" class="muted">Todavía no se ejecutó ninguna conciliación.</td></tr>
				{/each}
			</tbody>
		</table>
	</div>
</section>

<style>
	.head {
		display: flex;
		justify-content: space-between;
		align-items: start;
		gap: 1rem;
		margin-bottom: 1.5rem;
	}

	h1 {
		font-size: var(--step-4);
		text-transform: uppercase;
	}

	h2 {
		font-size: var(--step-1);
		text-transform: uppercase;
	}

	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}

	.panel {
		margin-bottom: 1rem;
		display: grid;
		gap: 0.9rem;
	}

	.section-head {
		display: flex;
		flex-wrap: wrap;
		justify-content: space-between;
		align-items: end;
		gap: 1rem;
	}

	.period,
	.filters {
		display: flex;
		flex-wrap: wrap;
		gap: 0.75rem;
		align-items: end;
	}

	.cards {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
		gap: 0.75rem;
	}

	.card {
		display: grid;
		gap: 0.3rem;
		padding: 1rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		background: var(--surface-2);
	}

	.value {
		font: 800 var(--step-2) / 1.1 var(--font-display);
		font-variant-numeric: tabular-nums;
	}

	.exports {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem 0.75rem;
		align-items: center;
	}

	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
		gap: 1rem;
	}

	.grid .panel {
		align-content: start;
	}

	.upload {
		display: grid;
		gap: 0.75rem;
		justify-items: start;
	}

	.small {
		font-size: var(--step--1);
	}

	.table-wrap {
		overflow-x: auto;
		border: 1px solid var(--border);
		border-radius: var(--radius);
	}

	table {
		width: 100%;
		border-collapse: collapse;
		font-size: var(--step--1);
	}

	th,
	td {
		padding: 0.8rem 1rem;
		text-align: left;
		border-bottom: 1px solid var(--border);
		vertical-align: top;
	}

	th {
		background: var(--surface);
		font-weight: 700;
		white-space: nowrap;
	}

	.what {
		display: grid;
		gap: 0.35rem;
		justify-items: start;
		min-width: 18rem;
	}

	.actions {
		display: grid;
		gap: 0.5rem;
		justify-items: start;
		min-width: 14rem;
	}

	summary {
		cursor: pointer;
		font-weight: 600;
	}

	.accept {
		display: grid;
		gap: 0.6rem;
		margin-top: 0.6rem;
	}

	.pager {
		display: flex;
		gap: 1rem;
		align-items: center;
	}
</style>
