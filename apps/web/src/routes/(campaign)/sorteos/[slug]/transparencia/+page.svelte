<script lang="ts">
	import { campaignStatusLabel, dateTime } from '#lib/format.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const t = $derived(data.transparency);
	const timezone = $derived(data.site?.organization.timezone ?? 'America/Argentina/Buenos_Aires');
	const status = $derived(campaignStatusLabel[t.status] ?? { label: t.status, tone: 'neutral' as const });
	const fulfillment: Record<string, string> = { pending: 'Entrega pendiente', scheduled: 'Entrega coordinada', delivered: 'Entregado', failed: 'Entrega fallida' };
</script>

<svelte:head>
	<title>Transparencia | {t.title}</title>
	<meta name="description" content="Registro verificable de {t.title}: bases, participaciones, manifiesto y resultados." />
</svelte:head>

<section class="container page">
	<a class="back" href="/sorteos/{t.slug}">Volver a la campaña</a>
	<div class="chips">
		<span class="chip {status.tone}">{status.label}</span>
		{#if t.isDemo}<span class="chip neutral">Campaña de demostración</span>{/if}
	</div>
	<h1>Transparencia</h1>
	<p class="lead muted">{t.title}. Todo lo que se publica acá queda registrado y no se puede modificar después: si algo cambia, se agrega una entrada nueva.</p>

	<dl class="totals">
		<div><dt>Participaciones válidas</dt><dd>{t.totals.eligibleEntries}</dd></div>
		<div><dt>Participantes</dt><dd>{t.totals.participants}</dd></div>
		<div><dt>Anuladas por reintegro</dt><dd>{t.totals.voidedEntries}</dd></div>
	</dl>

	<section class="block" aria-labelledby="manifest-title">
		<h2 id="manifest-title">Lista congelada al cierre</h2>
		{#if t.manifest}
			<div class="panel manifest">
				<p>Publicada el {dateTime(t.manifest.publishedAt, timezone)} con {t.manifest.eligibleCount} participaciones válidas.</p>
				<p class="muted small">Huella SHA-256</p>
				<p class="hash big">{t.manifest.sha256}</p>
				<a class="button secondary small" href="/sorteos/{t.slug}/manifiesto" download>Descargar lista</a>
				<details>
					<summary>Cómo verificarla</summary>
					<p class="muted">Descargá el archivo y calculá su huella. Si coincide con la publicada, la lista es exactamente la que se congeló al cierre. La lista usa identificadores seudónimos: no contiene nombres ni documentos.</p>
					<pre><code>sha256sum {t.slug}-manifiesto.ndjson        # Linux
shasum -a 256 {t.slug}-manifiesto.ndjson    # macOS
Get-FileHash {t.slug}-manifiesto.ndjson     # Windows PowerShell</code></pre>
				</details>
			</div>
		{:else}
			<p class="muted">Se publica cuando cierra la campaña, antes de cualquier selección de ganadores.</p>
		{/if}
	</section>

	<section class="block" aria-labelledby="timeline-title">
		<h2 id="timeline-title">Registro</h2>
		{#if t.timeline.length}
			<ol class="timeline">
				{#each t.timeline as event, index (index)}
					<li>
						<time datetime={event.occurredAt}>{dateTime(event.occurredAt, timezone, 'short')}</time>
						<div>
							<p class="event-title">{event.title}</p>
							{#if event.detail}<p class="muted small">{event.detail}</p>{/if}
							{#if event.evidenceUrl}<a class="small" href={event.evidenceUrl} rel="noopener nofollow" target="_blank">Ver evidencia</a>{/if}
						</div>
					</li>
				{/each}
			</ol>
		{:else}
			<p class="muted">Todavía no hay eventos registrados.</p>
		{/if}
	</section>

	<section class="block" aria-labelledby="rules-title">
		<h2 id="rules-title">Versiones de las bases</h2>
		{#if t.ruleVersions.length}
			<ul class="versions">
				{#each t.ruleVersions as rule (rule.version)}
					<li>
						<strong>Versión {rule.version}</strong>
						<span class="chip {rule.status === 'locked' ? 'ok' : 'neutral'}">{rule.status === 'locked' ? 'Vigente' : 'Reemplazada'}</span>
						{#if rule.lockedAt}<span class="muted small">desde {dateTime(rule.lockedAt, timezone, 'short')}</span>{/if}
						{#if rule.contentHash}<span class="hash small">{rule.contentHash}</span>{/if}
						{#if rule.announcement}<p class="small">{rule.announcement}</p>{/if}
					</li>
				{/each}
			</ul>
		{:else}
			<p class="muted">Las bases quedan bloqueadas y publicadas acá cuando la campaña abre.</p>
		{/if}
	</section>

	{#if t.awards.length}
		<section class="block" aria-labelledby="awards-title">
			<h2 id="awards-title">Adjudicaciones y entregas</h2>
			<ul class="versions">
				{#each t.awards as award (award.prize + award.slot + award.role)}
					<li>
						<strong>{award.prize}</strong>
						<span>Participación #{award.entryNumber ?? '—'}</span>
						<span class="chip neutral">{award.role === 'winner' ? 'Ganador' : 'Suplente'}</span>
						{#if award.fulfillment}<span class="muted small">{fulfillment[award.fulfillment.status]}</span>{/if}
						{#if award.fulfillment?.evidenceUrl}<a class="small" href={award.fulfillment.evidenceUrl} rel="noopener nofollow" target="_blank">Ver entrega</a>{/if}
					</li>
				{/each}
			</ul>
		</section>
	{/if}
</section>

<style>
	.page {
		padding-top: clamp(2rem, 1.5rem + 3vw, 4rem);
		display: grid;
		gap: 1.25rem;
	}

	.back {
		font-size: var(--step--1);
	}

	.chips {
		display: flex;
		gap: 0.5rem;
	}

	h1 {
		font-size: var(--step-5);
		text-transform: uppercase;
	}

	.lead {
		max-width: 62ch;
		font-size: var(--step-1);
	}

	h2 {
		font-size: var(--step-3);
		text-transform: uppercase;
	}

	.totals {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 1rem;
		margin: 1rem 0;
	}

	.totals div {
		padding: 1.25rem;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--surface);
	}

	dt {
		font-size: var(--step--1);
		color: var(--muted);
	}

	dd {
		margin: 0.3rem 0 0;
		font: 800 var(--step-4) / 1 var(--font-display);
	}

	.block {
		display: grid;
		gap: 1rem;
		padding-top: 2rem;
	}

	.manifest {
		display: grid;
		gap: 0.6rem;
		justify-items: start;
	}

	.big {
		font-size: var(--step-0);
	}

	pre {
		overflow-x: auto;
		padding: 1rem;
		background: var(--surface-2);
		border-radius: var(--radius-sm);
		font-size: var(--step--1);
	}

	.timeline,
	.versions {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.timeline li {
		display: grid;
		grid-template-columns: 11rem 1fr;
		gap: 1rem;
		padding-block: 1rem;
		border-top: 1px solid var(--border);
	}

	time {
		color: var(--muted);
		font-size: var(--step--1);
	}

	.event-title {
		font-weight: 700;
	}

	.versions li {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem 1rem;
		align-items: center;
		padding-block: 1rem;
		border-top: 1px solid var(--border);
	}

	.small {
		font-size: var(--step--1);
	}

	@media (max-width: 720px) {
		.totals {
			grid-template-columns: 1fr;
		}

		.timeline li {
			grid-template-columns: 1fr;
			gap: 0.25rem;
		}
	}
</style>
