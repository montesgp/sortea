<script lang="ts">
	import { formatEntryNumber, padEntryNumber } from '@sortea/domain';
	import { awardSourceLabel, candidateListFile, candidateListHref, prizeDrawListFile, prizeDrawListHref, tiradaListFile, tiradaListHref, verifyAppDrawCommand } from '#lib/app-draw.js';
	import { campaignStatusLabel, dateTime } from '#lib/format.js';
	import { drawnAtLabel, ordinal } from '#lib/quiniela.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const t = $derived(data.transparency);
	const timezone = $derived(data.site?.organization.timezone ?? 'America/Argentina/Buenos_Aires');
	const status = $derived(campaignStatusLabel[t.status] ?? { label: t.status, tone: 'neutral' as const });
	// After a vacancy reopened the campaign every round has its own manifest, draw and results (ADR 0014 §5).
	const rounds = $derived(t.round > 1);
	const manifestHref = (round: number) => (rounds ? `/sorteos/${t.slug}/manifiesto?ronda=${round}` : `/sorteos/${t.slug}/manifiesto`);
	const manifestFile = $derived(rounds ? `${t.slug}-manifiesto-ronda-${t.manifests.at(-1)?.round ?? t.round}.ndjson` : `${t.slug}-manifiesto.ndjson`);
	const appDraws = $derived(t.appDraws ?? []);
	// One record per tirada (ADR 0024 §6 as amended 2026-11-13), grouped by round.
	const tiradas = $derived(t.appUnitDraws ?? []);
	const tiradaRounds = $derived([...new Set(tiradas.map((tirada) => tirada.round))]);
	// ADR 0026 §6 (draw-room T9): one drand-backed tirada per `app` prize.
	const prizeDraws = $derived(t.appPrizeDraws ?? []);
	const publishedPrizeDraws = $derived(prizeDraws.filter((draw) => draw.candidateSha256));
	const unitsText = (count: number) => (count === 1 ? '1 unidad' : `${count} unidades`);
	const voidSlots = $derived(t.voidSlots ?? []);
	const coupons = (count: number) => (count === 1 ? '1 cupón' : `${count} cupones`);
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
		<h2 id="manifest-title">{rounds ? 'Listas congeladas al cierre de cada ronda' : 'Lista congelada al cierre'}</h2>
		{#each t.manifests as manifest (manifest.round)}
			<div class="panel manifest">
				{#if rounds}<p><strong>Ronda {manifest.round}</strong></p>{/if}
				<p>Publicada el {dateTime(manifest.publishedAt, timezone)} con {manifest.eligibleCount} participaciones válidas.</p>
				<p class="muted small">Huella SHA-256</p>
				<p class="hash big">{manifest.sha256}</p>
				<a class="button secondary small" href={manifestHref(manifest.round)} download>Descargar lista</a>
			</div>
		{:else}
			<p class="muted">Se publica cuando cierra la campaña, antes de cualquier selección de ganadores.</p>
		{/each}
		{#if t.manifests.length}
			<details>
				<summary>Cómo verificarla</summary>
				<p class="muted">
					Descargá el archivo y calculá su huella. Si coincide con la publicada, la lista es exactamente la que se congeló al cierre{rounds ? ' de esa ronda' : ''}. La lista usa identificadores
					seudónimos: no contiene nombres ni documentos.
				</p>
				<pre><code>sha256sum {manifestFile}        # Linux
shasum -a 256 {manifestFile}    # macOS
Get-FileHash {manifestFile}     # Windows PowerShell</code></pre>
			</details>
		{/if}
		{#if rounds && t.status === 'open'}
			<p class="muted">La lista de la ronda {t.round} se publica cuando cierra, antes de su sorteo. Incluye los cupones de todas las rondas.</p>
		{/if}
	</section>

	{#each t.quinielaDraws as draw (draw.round)}
		<section class="block" aria-labelledby="quiniela-{draw.round}">
			<h2 id="quiniela-{draw.round}">Sorteo de la Quiniela{rounds ? `, ronda ${draw.round}` : ''}</h2>
			<div class="panel manifest">
				<p>{draw.source}, sorteo del {drawnAtLabel(draw.drawnAt, timezone)}.</p>
				{#if rounds}<p class="muted small">Comparado con la lista de la ronda {draw.round} (huella {draw.manifestSha256}).</p>{/if}
				<p class="muted small">
					Los 20 extractos en su orden oficial. Cada extracto se compara, en orden, con los cupones de la lista congelada: el primero que coincide gana la primera
					unidad, el siguiente la segunda, y los que siguen quedan como suplentes.
				</p>
				<ol class="extracts">
					{#each draw.extracts as number, index (index)}
						<li><span class="muted">{ordinal(index + 1)}</span> <span class="hash">{padEntryNumber(number, 4)}</span></li>
					{/each}
				</ol>
				<a class="small" href={draw.evidenceUrl} rel="noopener nofollow" target="_blank">Ver extracto oficial</a>
			</div>
		</section>
	{/each}

	<!-- ADR 0024 §6: the prizes a round's Quiniela left vacant, drawn in the application among the coupons without a prize. -->
	{#each appDraws as draw (draw.round)}
		<section class="block" aria-labelledby="app-draw-{draw.round}">
			<h2 id="app-draw-{draw.round}">Sorteo en la app{rounds ? `, ronda ${draw.round}` : ''}</h2>
			<div class="panel manifest">
				<p>Los premios vacantes se sortearon en la aplicación el {dateTime(draw.drawnAt, timezone)} entre {coupons(draw.candidateCount)} sin premio.</p>
				<p class="muted small">
					La plataforma eligió con un número aleatorio criptográfico entre los cupones válidos que no tenían premio, y guardó el resultado antes de mostrarlo. Huella SHA-256 de la
					lista de cupones
				</p>
				<p class="hash big">{draw.candidateSha256}</p>
				{#if draw.picks}
					<ul class="picks">
						{#each draw.picks as pick (`${pick.prize}-${pick.slot}-${pick.role}-${pick.rank}`)}
							<li>{pick.prize}, unidad {pick.slot}: {pick.role === 'winner' ? 'Ganador' : `Suplente ${pick.rank}`}, cupón <span class="hash">{pick.entryNumber}</span></li>
						{/each}
					</ul>
				{:else}
					<p class="muted small">El resultado se publica con los resultados de la ronda.</p>
				{/if}
				<!-- T13: the list is a file, not the page, since it can hold thousands of coupons. -->
				<a class="button secondary small" href={candidateListHref(t.slug, draw.round)} download={candidateListFile(t.slug, draw.round)}>Descargar la lista de cupones (.txt)</a>
				<details>
					<summary>Cómo verificarla</summary>
					<p class="muted">
						El archivo tiene los {coupons(draw.candidateCount)} que participaron, solo los números: un cupón por renglón, en orden ascendente y sin salto de línea al final.
						Calculá su huella: si coincide con la publicada, es exactamente la lista que se sorteó.
					</p>
					<pre><code>sha256sum {candidateListFile(t.slug, draw.round)}        # Linux
shasum -a 256 {candidateListFile(t.slug, draw.round)}    # macOS
Get-FileHash {candidateListFile(t.slug, draw.round)}     # Windows PowerShell</code></pre>
				</details>
			</div>
		</section>
	{/each}

	<!-- ADR 0024 §6 (amended for the draw room, T3/T5): each in-app tirada drew one unit; its list of coupons is its own file. -->
	{#each tiradaRounds as round (round)}
		<section class="block" aria-labelledby="tiradas-{round}">
			<h2 id="tiradas-{round}">Tiradas del sorteo en la app{rounds ? `, ronda ${round}` : ''}</h2>
			<p class="muted small">
				Cada tirada sorteó una unidad vacante entre los cupones válidos que no tenían premio, con un número aleatorio criptográfico, y quedó guardada antes de mostrarse. Cada una tiene su
				lista de cupones y su huella SHA-256.
			</p>
			<ol class="tiradas">
				{#each tiradas.filter((tirada) => tirada.round === round) as tirada (tirada.sequence)}
					<li class="panel manifest">
						<p>
							<strong>Tirada {tirada.sequence}</strong>: {tirada.prize}, unidad {tirada.slot}{tirada.attempt > 1 ? ` (se sorteó de nuevo, intento ${tirada.attempt})` : ''}. El
							{dateTime(tirada.drawnAt, timezone)}, entre {coupons(tirada.candidateCount)} sin premio.
						</p>
						<!-- Each list is the previous one minus its pick: list and hash wait for the results, like the pick. -->
						{#if tirada.entryNumber && tirada.candidateSha256}
							<p>Cupón sorteado: <span class="hash">{tirada.entryNumber}</span></p>
							<p class="muted small">Huella SHA-256 de la lista de cupones</p>
							<p class="hash big">{tirada.candidateSha256}</p>
							<a class="button secondary small" href={tiradaListHref(t.slug, tirada.round, tirada.sequence)} download={tiradaListFile(t.slug, tirada.round, tirada.sequence)}
								>Descargar la lista de cupones de la tirada {tirada.sequence} (.txt)</a
							>
						{:else}
							<p class="muted small">El cupón sorteado, la lista de cupones y su huella se publican con los resultados de la ronda.</p>
						{/if}
					</li>
				{/each}
			</ol>
			{#if tiradas.some((tirada) => tirada.round === round && tirada.candidateSha256)}
			<details>
				<summary>Cómo verificarlas</summary>
				<p class="muted">
					Cada archivo tiene los cupones que participaron de esa tirada, solo los números: un cupón por renglón, en orden ascendente y sin salto de línea al final. Calculá su huella:
					si coincide con la publicada, es exactamente la lista que se sorteó.
				</p>
				<pre><code>sha256sum {tiradaListFile(t.slug, round, 1)}        # Linux
shasum -a 256 {tiradaListFile(t.slug, round, 1)}    # macOS
Get-FileHash {tiradaListFile(t.slug, round, 1)}     # Windows PowerShell</code></pre>
			</details>
			{/if}
		</section>
	{/each}

	{#if prizeDraws.length}
		<section class="block" aria-labelledby="prize-draws-title">
			<h2 id="prize-draws-title">Sorteo en la app con número público (drand)</h2>
			<p class="muted small">
				Cada premio se sorteó con una sola tirada. Al tocar «Sortear» quedaron guardadas la lista de cupones válidos sin premio y la próxima ronda de drand: un número público que la red
				League of Entropy firma cada 3 segundos y que todavía no existía. Los ganadores salen de ese número y de la lista con un algoritmo publicado.
			</p>
			<ol class="tiradas">
				{#each prizeDraws as draw (`${draw.round}-${draw.sequence}`)}
					<li class="panel manifest">
						<p>
							<strong>Tirada {draw.sequence}</strong>: {draw.prize}, {unitsText(draw.units.length)}{draw.attempt > 1 ? ` (se sorteó de nuevo, intento ${draw.attempt})` : ''}{rounds ? `, ronda ${draw.round}` : ''}. Comprometida el
							{dateTime(draw.committedAt, timezone)} con la ronda {draw.drandRound} de drand, entre {coupons(draw.candidateCount)} sin premio.
						</p>
						{#if draw.candidateSha256}
							{#if draw.picks}
								<ul class="picks">
									{#each draw.picks as pick (pick.slot)}
										<li>{draw.units.length > 1 ? `Unidad ${pick.slot}` : 'Ganador'}: cupón <span class="hash">{pick.entryNumber}</span></li>
									{/each}
								</ul>
							{:else}
								<p class="muted small">La ronda {draw.drandRound} de drand todavía no se leyó: la tirada sigue comprometida con ella.</p>
							{/if}
							<p class="muted small">Huella SHA-256 de la lista de cupones</p>
							<p class="hash big">{draw.candidateSha256}</p>
							{#if draw.beacon}
								<p class="muted small">Número público de la ronda {draw.drandRound} (randomness)</p>
								<p class="hash big">{draw.beacon.randomness}</p>
								<a class="small" href={draw.beacon.url} rel="noopener nofollow" target="_blank">Ver la ronda {draw.drandRound} en drand</a>
							{/if}
							<a class="button secondary small" href={prizeDrawListHref(t.slug, draw.round, draw.sequence)} download={prizeDrawListFile(t.slug, draw.round, draw.sequence)}
								>Descargar la lista de cupones de la tirada {draw.sequence} (.txt)</a
							>
						{:else}
							<p class="muted small">Los ganadores, la lista de cupones, su huella y el número de drand se publican con los resultados de la ronda.</p>
						{/if}
					</li>
				{/each}
			</ol>
			{#if publishedPrizeDraws.length}
				<details>
					<summary>Cómo verificarlo</summary>
					<p class="muted">
						Descargá el código abierto de la plataforma, guardá la lista de la tirada en su carpeta principal y, con Node.js, corré desde esa carpeta:
					</p>
					<pre><code>{publishedPrizeDraws.map((draw) => verifyAppDrawCommand({ file: prizeDrawListFile(t.slug, draw.round, draw.sequence), count: draw.units.length, drandRound: draw.drandRound })).join('\n')}</code></pre>
					<p class="muted">
						El script calcula la huella SHA-256 del archivo, lee la ronda de drand de un servidor público, comprueba que su número sea el SHA-256 de la firma de la ronda y recalcula los
						ganadores en orden con el algoritmo publicado: el primero es el de la unidad 1. Si la huella y los ganadores coinciden con los de esta página, el resultado salió de la lista
						guardada y de un número que nadie conocía al confirmar la tirada, así que la plataforma no pudo elegirlo. La firma de la ronda también se puede comprobar con cualquier cliente de
						drand. Que la lista tenga todos los cupones válidos sin premio se comprueba con la lista congelada al cierre y la búsqueda de cupones.
					</p>
				</details>
			{/if}
		</section>
	{/if}

	<section class="block" aria-labelledby="timeline-title">
		<h2 id="timeline-title">Registro</h2>
		{#if t.timeline.length}
			<ol class="timeline">
				{#each t.timeline as event, index (index)}
					<li>
						<time datetime={event.occurredAt}>{dateTime(event.occurredAt, timezone)}</time>
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
						{#if rule.lockedAt}<span class="muted small">desde {dateTime(rule.lockedAt, timezone)}</span>{/if}
						{#if rule.contentHash}<span class="hash small">{rule.contentHash}</span>{/if}
						{#if rule.announcement}<p class="small">{rule.announcement}</p>{/if}
					</li>
				{/each}
			</ul>
		{:else}
			<p class="muted">Las bases quedan bloqueadas y publicadas acá cuando la campaña abre.</p>
		{/if}
	</section>

	{#if t.awards.length || t.vacantSlots.length || voidSlots.length}
		<section class="block" aria-labelledby="awards-title">
			<h2 id="awards-title">Adjudicaciones y entregas</h2>
			<ul class="versions">
				{#each t.awards as award (`${award.round}-${award.prize}-${award.slot}-${award.role}`)}
					<li>
						<strong>{award.prize}</strong>
						<span>Cupón {award.entryNumber === null ? '—' : formatEntryNumber(award.entryNumber, t.entryDigits)}</span>
						<span class="chip neutral">{award.role === 'winner' ? 'Ganador' : 'Suplente'}</span>
						{#if awardSourceLabel(award.source)}<span class="chip neutral">{awardSourceLabel(award.source)}</span>{/if}
						{#if rounds}<span class="muted small">Ronda {award.round}</span>{/if}
						{#if award.extractPosition}<span class="muted small">extracto {ordinal(award.extractPosition)}</span>{/if}
						{#if award.fulfillment}<span class="muted small">{fulfillment[award.fulfillment.status]}</span>{/if}
						{#if award.fulfillment?.evidenceUrl}<a class="small" href={award.fulfillment.evidenceUrl} rel="noopener nofollow" target="_blank">Ver entrega</a>{/if}
					</li>
				{/each}
				{#each t.vacantSlots as vacant (`${vacant.round}-${vacant.prize}-${vacant.slot}`)}
					<li>
						<strong>{vacant.prize}, unidad {vacant.slot}</strong>
						<span class="chip bad">{rounds ? `Vacante en la ronda ${vacant.round}` : 'Vacante'}</span>
					</li>
				{/each}
				<!-- T13: nobody could win these units any more; the reason is public. -->
				{#each voidSlots as declared (`${declared.prize}-${declared.slot}`)}
					<li>
						<strong>{declared.prize}, unidad {declared.slot}</strong>
						<span class="chip neutral">Desierto</span>
						<span class="muted small">{declared.reason}</span>
					</li>
				{/each}
			</ul>
		</section>
	{/if}
</section>

<style>
	/* minmax(0, 1fr): a wide child (chips, hashes, the verify commands) must not stretch the column past the viewport. */
	.page {
		padding-top: clamp(2rem, 1.5rem + 3vw, 4rem);
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 1.25rem;
	}

	.back {
		font-size: var(--step--1);
	}

	.chips {
		display: flex;
		flex-wrap: wrap;
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
		grid-template-columns: minmax(0, 1fr);
		gap: 1rem;
		padding-top: 2rem;
	}

	.manifest {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
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

	.extracts {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(6.5rem, 1fr));
		gap: 0.35rem 0.75rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.tiradas {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 0.75rem;
	}

	.picks {
		margin: 0;
		padding-left: 1.2rem;
		display: grid;
		gap: 0.25rem;
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
