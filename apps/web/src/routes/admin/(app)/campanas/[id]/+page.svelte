<script lang="ts">
	import TextArea from '#lib/components/TextArea.svelte';
	import { minorToInput } from '#lib/catalog.js';
	import { campaignStatusLabel, dateTime, money, prizeKindLabel } from '#lib/format.js';
	import { toLocalInput } from '#lib/tz.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const campaign = $derived(data.campaign);
	const currency = $derived(data.session.organization.currency);
	const can = (permission: string) => data.session.permissions.includes(permission);
	const status = $derived(campaignStatusLabel[campaign.status] ?? { label: campaign.status, tone: 'neutral' as const });
	const editableSchedule = $derived(['draft', 'review', 'published'].includes(campaign.status));
	const latestRules = $derived(campaign.rules[0]);

	const transitionLabel: Record<string, string> = {
		draft: 'Volver a borrador',
		review: 'Enviar a revisión',
		published: 'Publicar',
		open: 'Abrir participaciones',
		awarding: 'Pasar a adjudicación',
		fulfilled: 'Marcar premios entregados',
		archived: 'Archivar'
	};
	const approvalLabel = { legal: 'Autorización legal', psp: 'Aprobación del medio de pago' } as const;
	const missingLabel: Record<string, string> = { legal: 'autorización legal', psp: 'aprobación del medio de pago' };

	const feedback = (action: string) => (form?.action === action ? form : null);
</script>

<svelte:head>
	<title>{campaign.title} | Panel</title>
</svelte:head>

{#snippet message(action: string)}
	{@const result = feedback(action)}
	{#if result}<p class="notice {result.ok ? 'ok' : 'error'}" role={result.ok ? 'status' : 'alert'}>{result.message}</p>{/if}
{/snippet}

{#snippet prizeFields(prize: (typeof data.prizeEditor.prizes)[number] | null)}
	{@const key = prize?.id ?? 'new'}
	<div class="row">
		<div class="field">
			<label for="pkind-{key}">Tipo</label>
			<select id="pkind-{key}" name="kind">
				{#each Object.entries(prizeKindLabel) as [value, label] (value)}
					<option {value} selected={(prize?.kind ?? 'product') === value}>{label}</option>
				{/each}
			</select>
		</div>
		<div class="field"><label for="ptitle-{key}">Título</label><input id="ptitle-{key}" name="title" required minlength="3" defaultValue={prize?.title ?? ''} /></div>
	</div>
	<div class="row three">
		<div class="field"><label for="pvalue-{key}">Valor declarado por unidad</label><input id="pvalue-{key}" name="declaredValue" inputmode="decimal" required defaultValue={prize ? minorToInput(prize.declaredValueMinor) : ''} /></div>
		<div class="field"><label for="pqty-{key}">Unidades</label><input id="pqty-{key}" name="quantity" type="number" min="1" max="1000" defaultValue={String(prize?.quantity ?? 1)} /></div>
		<div class="field"><label for="palt-{key}">Suplentes por unidad</label><input id="palt-{key}" name="alternatesCount" type="number" min="0" max="10" defaultValue={String(prize?.alternatesCount ?? 1)} /></div>
	</div>
	<div class="field"><label for="pdesc-{key}">Descripción</label><TextArea id="pdesc-{key}" name="description" rows={2} value={prize?.description ?? ''} /></div>
	<div class="field"><label for="pcond-{key}">Condiciones de entrega</label><TextArea id="pcond-{key}" name="conditions" rows={2} value={prize?.conditions ?? ''} /></div>
	<div class="row">
		<div class="field"><label for="pimg-{key}">Imagen</label><input id="pimg-{key}" name="imageUrl" placeholder="/tenants/… o https://…" defaultValue={prize?.imageUrl ?? ''} /></div>
		<div class="field"><label for="ppos-{key}">Orden</label><input id="ppos-{key}" name="position" type="number" min="1" defaultValue={prize ? String(prize.position) : ''} /></div>
	</div>
{/snippet}

<a class="small" href="/admin/campanas">Volver a campañas</a>
<header class="head">
	<div>
		<h1>{campaign.title}</h1>
		<p class="muted small">Página pública: <a href="/sorteos/{campaign.slug}" target="_blank">/sorteos/{campaign.slug}</a></p>
	</div>
	<div class="chips">
		<span class="chip {status.tone}">{status.label}</span>
		{#if campaign.isDemo}<span class="chip neutral">Demostración</span>{/if}
	</div>
</header>

<section class="panel gate" aria-labelledby="gate-title">
	<h2 id="gate-title">Estado y habilitación</h2>
	{#if campaign.gate.allowed}
		<p class="notice ok">Las aprobaciones requeridas están registradas.</p>
	{:else}
		<p class="notice">
			Para abrir participaciones falta {campaign.gate.missing.map((kind) => missingLabel[kind]).join(' y ')}{campaign.gate.rejected.length ? `; hay aprobaciones rechazadas` : ''}. La plataforma no permite abrir la campaña sin ellas.
		</p>
	{/if}
	<dl class="facts">
		<div><dt>Participaciones vigentes</dt><dd>{campaign.totals.eligibleEntries}</dd></div>
		<div><dt>Participantes</dt><dd>{campaign.totals.participants}</dd></div>
		<div><dt>Apertura</dt><dd>{dateTime(campaign.opensAt, campaign.timezone, 'short')}</dd></div>
		<div><dt>Cierre</dt><dd>{dateTime(campaign.closesAt, campaign.timezone, 'short')}</dd></div>
	</dl>
	{@render message('transition')}
	{@render message('close')}
	{#if can('campaigns.manage')}
		<div class="actions">
			{#each campaign.allowedTransitions as to (to)}
				<form method="POST" action="?/transition">
					<input type="hidden" name="to" value={to} />
					<button class="button small {to === 'open' ? '' : 'secondary'}" disabled={to === 'open' && !campaign.gate.allowed}>{transitionLabel[to] ?? to}</button>
				</form>
			{/each}
			{#if campaign.status === 'open'}
				<form method="POST" action="?/close">
					<button class="button small" disabled={!campaign.canClose} title={campaign.canClose ? '' : 'Disponible una hora después del cierre, cuando vencen los pagos en curso'}>Cerrar y publicar manifiesto</button>
				</form>
			{/if}
		</div>
	{/if}
	{#if campaign.manifest}
		<p class="small">Manifiesto publicado el {dateTime(campaign.manifest.publishedAt, campaign.timezone, 'short')}: <span class="hash">{campaign.manifest.sha256}</span></p>
	{/if}
</section>

<div class="grid">
	<section class="panel" aria-labelledby="approvals-title">
		<h2 id="approvals-title">Aprobaciones</h2>
		<p class="muted small">Registrá solo aprobaciones reales, con su autoridad y número de expediente o caso.</p>
		{#each campaign.approvals as approval (approval.kind)}
			{@render message(`approval-${approval.kind}`)}
			<form method="POST" action="?/approval" class="stack approval">
				<input type="hidden" name="kind" value={approval.kind} />
				<p class="label">{approvalLabel[approval.kind]}</p>
				<div class="row">
					<div class="field">
						<label for="status-{approval.kind}">Estado</label>
						<select id="status-{approval.kind}" name="status" disabled={!can('campaigns.approve')}>
							{#each [['pending', 'Pendiente'], ['approved', 'Aprobada'], ['rejected', 'Rechazada']] as [value, label] (value)}
								<option {value} selected={approval.status === value}>{label}</option>
							{/each}
						</select>
					</div>
					<div class="field">
						<label for="authority-{approval.kind}">Autoridad u organismo</label>
						<input id="authority-{approval.kind}" name="authority" defaultValue={approval.authority ?? ''} disabled={!can('campaigns.approve')} />
					</div>
				</div>
				<div class="field">
					<label for="reference-{approval.kind}">Número de expediente o caso</label>
					<input id="reference-{approval.kind}" name="reference" defaultValue={approval.reference ?? ''} disabled={!can('campaigns.approve')} />
				</div>
				{#if can('campaigns.approve') && editableSchedule}<button class="button small secondary">Guardar</button>{/if}
			</form>
		{/each}
	</section>

	<section class="panel" aria-labelledby="prizes-title">
		<h2 id="prizes-title">Premios</h2>
		{#if ['closed', 'awarding', 'fulfilled', 'archived'].includes(campaign.status)}
			<a class="button small secondary" href="/admin/campanas/{campaign.id}/premios">Adjudicaciones y entregas</a>
		{/if}
		{@render message('prize-new')}
		<ul class="list">
			{#each data.prizeEditor.prizes as prize (prize.id)}
				<li>
					<span class="qty">{prize.quantity}×</span>
					<span>
						{prize.title}<br /><span class="muted small">{prizeKindLabel[prize.kind]}, {prize.alternatesCount} suplente(s) por unidad</span>
						{@render message(`prize-${prize.id}`)}
						{#if data.prizeEditor.editable}
							<details open={feedback(`prize-${prize.id}`)?.ok === false}>
								<summary class="small">Editar</summary>
								<form method="POST" action="?/updatePrize" class="stack prize-form">
									<input type="hidden" name="prizeId" value={prize.id} />
									{@render prizeFields(prize)}
									<button class="button small">Guardar premio</button>
								</form>
								<form method="POST" action="?/deletePrize" class="prize-delete">
									<input type="hidden" name="prizeId" value={prize.id} />
									<button class="button quiet small">Quitar este premio</button>
								</form>
							</details>
						{/if}
					</span>
					<span class="money small">{money(prize.declaredValueMinor, currency)}</span>
				</li>
			{/each}
		</ul>
		{#if data.prizeEditor.editable}
			<details open={feedback('prize-new')?.ok === false}>
				<summary class="small">Agregar premio</summary>
				<form method="POST" action="?/addPrize" class="stack prize-form">
					{@render prizeFields(null)}
					<button class="button small secondary">Agregar premio</button>
				</form>
			</details>
		{:else}
			<p class="muted small">Los premios quedaron fijos al abrir la campaña: forman parte de lo publicado en las bases.</p>
		{/if}
	</section>
</div>

{#if can('campaigns.manage')}
	<section class="panel" aria-labelledby="details-title">
		<h2 id="details-title">Contenido y fechas</h2>
		{@render message('details')}
		<form method="POST" action="?/details" class="stack">
			<input type="hidden" name="timezone" value={campaign.timezone} />
			<div class="row">
				<div class="field"><label for="title">Título</label><input id="title" name="title" defaultValue={campaign.title} required /></div>
				<div class="field"><label for="subtitle">Bajada</label><input id="subtitle" name="subtitle" defaultValue={campaign.subtitle ?? ''} /></div>
			</div>
			<div class="field"><label for="summary">Resumen</label><TextArea id="summary" name="summary" required value={campaign.summary} /></div>
			<div class="row three">
				{#if editableSchedule}
					<div class="field"><label for="opensAt">Apertura ({campaign.timezone})</label><input id="opensAt" name="opensAt" type="datetime-local" defaultValue={toLocalInput(campaign.opensAt, campaign.timezone)} /></div>
					<div class="field"><label for="closesAt">Cierre</label><input id="closesAt" name="closesAt" type="datetime-local" defaultValue={toLocalInput(campaign.closesAt, campaign.timezone)} /></div>
				{/if}
				<div class="field"><label for="drawAt">Transmisión</label><input id="drawAt" name="drawAt" type="datetime-local" defaultValue={toLocalInput(campaign.drawAt, campaign.timezone)} /></div>
			</div>
			<div class="row">
				<div class="field"><label for="streamUrl">Transmisión en vivo (YouTube)</label><input id="streamUrl" name="streamUrl" type="url" placeholder="https://www.youtube.com/live/…" defaultValue={campaign.streamUrl ?? ''} /></div>
				<div class="field"><label for="replayUrl">Grabación</label><input id="replayUrl" name="replayUrl" type="url" defaultValue={campaign.replayUrl ?? ''} /></div>
			</div>
			{#if !editableSchedule}<p class="muted small">Las fechas de apertura y cierre quedaron fijas al abrir la campaña.</p>{/if}
			<button class="button small">Guardar contenido</button>
		</form>
	</section>

	<section class="panel" aria-labelledby="rules-title">
		<h2 id="rules-title">Bases y condiciones</h2>
		{@render message('rules')}
		{#if latestRules}
			<p class="muted small">
				Versión {latestRules.version}, {latestRules.status === 'draft' ? 'borrador editable' : latestRules.status === 'locked' ? 'bloqueada' : 'reemplazada'}.
				{#if latestRules.contentHash}Huella <span class="hash">{latestRules.contentHash.slice(0, 16)}…</span>{/if}
			</p>
		{/if}
		{#if ['draft', 'review', 'published', 'open'].includes(campaign.status)}
			<form method="POST" action="?/rules" class="stack">
				<div class="field">
					<label for="bodyMarkdown">Texto (Markdown)</label>
					<TextArea id="bodyMarkdown" name="bodyMarkdown" rows={12} value={latestRules?.bodyMarkdown ?? ''} />
				</div>
				{#if campaign.status === 'open'}
					<div class="field">
						<label for="announcement">Anuncio público del cambio</label>
						<textarea id="announcement" name="announcement" rows="3" required></textarea>
						<p class="hint">Con la campaña abierta, un cambio crea una versión nueva y se publica en la transparencia. La versión anterior queda registrada.</p>
					</div>
				{/if}
				<button class="button small">{campaign.status === 'open' ? 'Publicar nueva versión' : 'Guardar borrador'}</button>
			</form>
		{/if}
	</section>
{/if}

{#if can('campaigns.operate')}
	<section class="panel" aria-labelledby="events-title">
		<h2 id="events-title">Registro público</h2>
		<p class="muted small">Cada entrada se publica en la página de transparencia y no se puede borrar.</p>
		<ol class="list">
			{#each campaign.events as event, index (index)}
				<li><span class="small muted">{dateTime(event.occurredAt, campaign.timezone, 'short')}</span><span><strong>{event.title}</strong>{#if event.detail}<br /><span class="muted small">{event.detail}</span>{/if}</span></li>
			{:else}
				<li class="muted">Sin entradas todavía.</li>
			{/each}
		</ol>
		{@render message('drawEvent')}
		<form method="POST" action="?/drawEvent" class="stack">
			<input type="hidden" name="timezone" value={campaign.timezone} />
			<div class="row three">
				<div class="field">
					<label for="kind">Tipo</label>
					<select id="kind" name="kind">
						<option value="stream_scheduled">Transmisión programada</option>
						<option value="mechanism_recorded">Mecanismo de selección registrado</option>
						<option value="act_published">Acta publicada</option>
						<option value="result_published">Resultado publicado</option>
						<option value="note">Nota</option>
					</select>
				</div>
				<div class="field"><label for="occurredAt">Fecha</label><input id="occurredAt" name="occurredAt" type="datetime-local" required /></div>
				<div class="field"><label for="evidenceUrl">Evidencia (https)</label><input id="evidenceUrl" name="evidenceUrl" type="url" /></div>
			</div>
			<div class="field"><label for="eventTitle">Título</label><input id="eventTitle" name="title" required /></div>
			<div class="field"><label for="detail">Detalle</label><textarea id="detail" name="detail" rows="3"></textarea></div>
			<button class="button small secondary">Agregar al registro</button>
		</form>
	</section>
{/if}

<style>
	.head {
		display: flex;
		justify-content: space-between;
		align-items: start;
		gap: 1rem;
		margin: 0.75rem 0 1.5rem;
	}

	h1 {
		font-size: var(--step-4);
		text-transform: uppercase;
	}

	h2 {
		font-size: var(--step-1);
		text-transform: uppercase;
		margin-bottom: 0.75rem;
	}

	.chips {
		display: flex;
		gap: 0.5rem;
	}

	.panel {
		margin-bottom: 1rem;
		display: grid;
		gap: 0.9rem;
	}

	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(340px, 1fr));
		gap: 1rem;
		align-items: start;
	}

	.facts {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
		gap: 1rem;
		margin: 0;
	}

	dt {
		font-size: var(--step--1);
		color: var(--muted);
	}

	dd {
		margin: 0.2rem 0 0;
		font-weight: 700;
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.6rem;
	}

	.stack {
		display: grid;
		gap: 0.9rem;
	}

	.approval {
		padding-top: 0.9rem;
		border-top: 1px solid var(--border);
	}

	.label {
		font-weight: 700;
	}

	.row {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 0.9rem;
	}

	.row.three {
		grid-template-columns: repeat(3, 1fr);
	}

	.list {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.list li {
		display: grid;
		grid-template-columns: auto 1fr auto;
		gap: 0.9rem;
		align-items: center;
		padding-block: 0.7rem;
		border-bottom: 1px solid var(--border);
	}

	ol.list li {
		grid-template-columns: 9rem 1fr;
	}

	.prize-form {
		margin-top: 0.6rem;
	}

	.prize-delete {
		margin-top: 0.4rem;
	}

	summary {
		cursor: pointer;
		font-weight: 600;
	}

	.qty {
		font: 800 var(--step-2) / 1 var(--font-display);
		color: var(--accent);
	}

	.small {
		font-size: var(--step--1);
	}

	@media (max-width: 760px) {
		.row,
		.row.three {
			grid-template-columns: 1fr;
		}
	}
</style>
