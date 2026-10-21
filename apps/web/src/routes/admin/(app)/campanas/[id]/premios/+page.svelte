<script lang="ts">
	import { formatEntryNumber, padEntryNumber } from '@sortea/domain';
	import TextArea from '#lib/components/TextArea.svelte';
	import { awardStatusLabel, fulfillmentLabel, fulfillmentOptions, roleLabel, slotStateLabel } from '#lib/awards.js';
	import { dateTime, prizeKindLabel } from '#lib/format.js';
	import { drawnAtLabel, extractOutcomeLabel, ordinal } from '#lib/quiniela.js';
	import { toLocalInput } from '#lib/tz.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const board = $derived(data.board);
	const timezone = $derived(board.campaign.timezone);
	const digits = $derived(board.campaign.entryDigits);
	const typed = (entryNumber: number | null | undefined) => (entryNumber === null || entryNumber === undefined ? '' : padEntryNumber(entryNumber, digits));
	const feedback = (target: string) => (form?.target === target ? form : null);
	// ADR 0014 §2-§4: quiniela prizes are decided by the recorded draw, manual ones keep the slot editor.
	const hasQuiniela = $derived(board.prizes.some((prize) => prize.mechanism === 'quiniela'));
	const draft = $derived(form?.target === 'quiniela' ? form.input : undefined);
	const preview = $derived(form?.target === 'quiniela' ? form.preview : undefined);
	const prizeTitle = (prizeId: string | null) => board.prizes.find((prize) => prize.id === prizeId)?.title ?? '';
	const unit = (prizeId: string | null, slot: number | null) => `${prizeTitle(prizeId)}, unidad ${slot}`;
	const totals = $derived.by(() => {
		const slots = board.prizes.flatMap((prize) => prize.slots);
		return {
			units: slots.length,
			delivered: slots.filter((slot) => slot.state === 'delivered').length,
			exhausted: slots.filter((slot) => slot.state === 'exhausted').length,
			empty: slots.filter((slot) => slot.state === 'empty').length
		};
	});
</script>

<svelte:head>
	<title>Premios y entregas | {board.campaign.title}</title>
</svelte:head>

{#snippet message(target: string)}
	{@const result = feedback(target)}
	{#if result}<p class="notice {result.ok ? 'ok' : 'error'}" role={result.ok ? 'status' : 'alert'}>{result.message}</p>{/if}
{/snippet}

<a class="small" href="/admin/campanas/{board.campaign.id}">Volver a {board.campaign.title}</a>
<header class="head">
	<h1>Premios y entregas</h1>
	<p class="muted small">
		{totals.units} unidades: {totals.delivered} entregadas, {totals.exhausted} sin suplentes, {totals.empty} sin resultado.
	</p>
</header>

{#if board.campaign.round > 1 && ['open', 'closed'].includes(board.campaign.status)}
	<!-- ADR 0014 §5: a new round never freezes the winners of the previous ones. -->
	<p class="notice">
		Ronda {board.campaign.round} en curso: las decisiones y entregas de las rondas anteriores siguen abiertas. Los premios vacantes se adjudican cuando la ronda cierra y se registra
		su sorteo.
	</p>
{:else if board.campaign.status !== 'awarding'}
	<p class="notice">
		{board.campaign.status === 'fulfilled' || board.campaign.status === 'archived'
			? 'La campaña terminó: las adjudicaciones y entregas quedan como registro.'
			: 'Las adjudicaciones se registran con la campaña en adjudicación, después de cerrarla y publicar el manifiesto.'}
	</p>
{:else if !board.mechanismRecorded}
	<p class="notice">
		Antes de cargar resultados, registrá en el <a href="/admin/campanas/{board.campaign.id}">registro público</a> el mecanismo de selección autorizado (fuente
		oficial o acta). La plataforma no sortea: solo registra el resultado.
	</p>
{:else if board.resultsPublished}
	<p class="notice ok">Los resultados están publicados y ya no se pueden corregir. Las decisiones y entregas siguen abiertas.</p>
{:else}
	<p class="notice">
		Los resultados se pueden corregir hasta que se decide sobre alguien de la unidad o se publica el resultado. Cada número se valida contra el manifiesto publicado.
	</p>
{/if}
{#if !board.piiVisible}<p class="muted small">Los datos de contacto se muestran enmascarados para tu rol.</p>{/if}

{#if hasQuiniela}
	<section class="panel" aria-labelledby="quiniela-title">
		<h2 id="quiniela-title">Sorteo de la Quiniela{board.campaign.round > 1 ? `, ronda ${board.campaign.round}` : ''}</h2>
		{#if board.quinielaDraw}
			{@const draw = board.quinielaDraw}
			<p>
				{draw.source}, sorteo del {drawnAtLabel(draw.drawnAt, timezone)}.
				<a href={draw.evidenceUrl} target="_blank" rel="noopener nofollow">Extracto oficial</a>
			</p>
			<ol class="extracts">
				{#each draw.extracts as number, index (index)}
					<li><span class="muted">{ordinal(index + 1)}</span> <span class="number">{padEntryNumber(number, 4)}</span></li>
				{/each}
			</ol>
			<p class="muted small">El sorteo quedó registrado en la página de transparencia y no se puede modificar.</p>
		{:else if board.canOperate}
			<p class="muted small">
				Los premios que se definen con la Quiniela salen de los 20 extractos del sorteo oficial, leídos en orden: el primero que coincide con un cupón válido del manifiesto gana
				la primera unidad, el siguiente la segunda, y los que sobran quedan como suplentes. La plataforma no sortea: compara.
			</p>
			{@render message('quiniela')}
			<form method="POST" action="?/quinielaPreview" class="stack">
				<input type="hidden" name="timezone" value={timezone} />
				<div class="field">
					<label for="q-source">Sorteo</label>
					<input id="q-source" name="source" required minlength="3" placeholder="Quiniela de la Ciudad, Nocturna" defaultValue={draft?.source ?? ''} />
				</div>
				<div class="row">
					<div class="field">
						<label for="q-date">Fecha del sorteo</label>
						<input id="q-date" name="drawDate" type="date" required defaultValue={draft?.drawDate ?? ''} />
					</div>
					<div class="field">
						<label for="q-time">Hora oficial del sorteo ({timezone})</label>
						<input id="q-time" name="drawTime" type="time" required defaultValue={draft?.drawTime ?? ''} />
					</div>
				</div>
				<p class="hint">El sorteo tiene que ser posterior a la publicación del manifiesto: un sorteo anterior no se acepta.</p>
				<div class="field">
					<label for="q-extracts">Los 20 extractos, en su orden oficial</label>
					<TextArea id="q-extracts" name="extracts" rows={4} required value={draft?.extracts ?? ''} />
					<p class="hint">Pegalos separados por espacios, comas o renglones, del 1.º al 20.º. Cada uno es un número de 4 cifras.</p>
				</div>
				<div class="field">
					<label for="q-evidence">Enlace al extracto oficial (https)</label>
					<input id="q-evidence" name="evidenceUrl" type="url" required defaultValue={draft?.evidenceUrl ?? ''} />
				</div>
				<button class="button small secondary">Ver coincidencias</button>
			</form>

			{#if preview && draft}
				<div class="preview" aria-labelledby="q-preview-title">
					<h3 id="q-preview-title">Coincidencias</h3>
					<table class="extract-table">
						<thead><tr><th scope="col">Extracto</th><th scope="col">Número</th><th scope="col">Cupón</th><th scope="col">Resultado</th></tr></thead>
						<tbody>
							{#each preview.extracts as extract (extract.position)}
								<tr>
									<td>{ordinal(extract.position)}</td>
									<td class="number">{padEntryNumber(extract.number, 4)}</td>
									{#if extract.outcome === 'winner' || extract.outcome === 'alternate' || extract.outcome === 'spare'}
										<td class="number">{formatEntryNumber(extract.number, digits)}</td>
										<td>
											{#if extract.outcome === 'winner'}Ganador: {unit(extract.prizeId, extract.slot)}
											{:else if extract.outcome === 'alternate'}Suplente {extract.rank}: {unit(extract.prizeId, extract.slot)}
											{:else}{extractOutcomeLabel.spare}{/if}
										</td>
									{:else}
										<td colspan="2" class="muted">{extractOutcomeLabel[extract.outcome] ?? extract.outcome}</td>
									{/if}
								</tr>
							{/each}
						</tbody>
					</table>

					<h3>Resultado por unidad</h3>
					<ul class="outcomes">
						{#each preview.slots as slot (`${slot.prizeId}-${slot.slot}`)}
							<li>
								<strong>{slot.prizeTitle}, unidad {slot.slot}</strong>
								{#if slot.winner}
									<span>Ganador {formatEntryNumber(slot.winner.entryNumber, digits)} (extracto {ordinal(slot.winner.extract)})</span>
									{#each slot.alternates as alternate (alternate.rank)}
										<span>Suplente {alternate.rank} {formatEntryNumber(alternate.entryNumber, digits)} (extracto {ordinal(alternate.extract)})</span>
									{/each}
								{:else}
									<span class="chip bad">Vacante</span>
								{/if}
							</li>
						{/each}
					</ul>
					{#if preview.vacant.length}
						<p class="notice">Las unidades vacantes quedan sin ganador en este sorteo.</p>
					{/if}

					<form method="POST" action="?/quinielaConfirm" class="stack">
						<input type="hidden" name="source" value={draft.source} />
						<input type="hidden" name="timezone" value={timezone} />
						<input type="hidden" name="drawDate" value={draft.drawDate} />
						<input type="hidden" name="drawTime" value={draft.drawTime} />
						<input type="hidden" name="digest" value={preview.digest} />
						<input type="hidden" name="extracts" value={draft.extracts} />
						<input type="hidden" name="evidenceUrl" value={draft.evidenceUrl} />
						<p class="hint">Al confirmar se cargan los ganadores y suplentes de los premios de Quiniela y el sorteo se publica en la transparencia. No se puede deshacer.</p>
						<button class="button small">Confirmar y registrar el sorteo</button>
					</form>
				</div>
			{/if}
		{:else}
			<p class="muted small">Todavía no se registró el sorteo de la Quiniela.</p>
		{/if}
	</section>
{/if}

{#each board.prizes as prize (prize.id)}
	<section class="panel" aria-labelledby="prize-{prize.id}">
		<h2 id="prize-{prize.id}">{prize.title}</h2>
		<p class="muted small">
			{prizeKindLabel[prize.kind]}, {prize.quantity} unidad(es), {prize.alternatesCount} suplente(s) por unidad.
			{prize.mechanism === 'quiniela' ? 'Se define con el sorteo de la Quiniela.' : ''}
		</p>
		<div class="slots">
			{#each prize.slots as slot (slot.slot)}
				{@const state = slotStateLabel[slot.state] ?? { label: slot.state, tone: 'neutral' }}
				<article class="slot" aria-labelledby="slot-{prize.id}-{slot.slot}">
					<header class="slot-head">
						<h3 id="slot-{prize.id}-{slot.slot}">Unidad {slot.slot}</h3>
						<span class="chip {state.tone}">{state.label}</span>
					</header>
					{@render message(`slot-${prize.id}-${slot.slot}`)}

					{#if slot.awards.length}
						<ol class="awards">
							{#each slot.awards as award (award.id)}
								<li class:active={award.active}>
									<div class="who">
										<span class="label">{roleLabel(award.role, award.rank)}</span>
										<span class="number">{award.entryNumber === null ? 'N.º ?' : formatEntryNumber(award.entryNumber, digits)}</span>
										<span class="small">{awardStatusLabel[award.status] ?? award.status}</span>
									</div>
									{#if award.holder}
										<p class="small">{award.holder.name} · {award.holder.email}{award.holder.phone ? ` · ${award.holder.phone}` : ''}{award.holder.location ? ` · ${award.holder.location}` : ''}</p>
									{/if}
									{#if award.entryVoidedAfterClose}
										<p class="notice error small">El pago de esta participación se revirtió después del cierre. Revisá qué dicen las bases antes de decidir.</p>
									{/if}
									{#if award.notes}<p class="muted small">{award.notes}</p>{/if}
									{@render message(`award-${award.id}`)}

									{#if award.operable && award.active && award.status === 'pending_verification'}
										<div class="actions">
											<form method="POST" action="?/decide">
												<input type="hidden" name="awardId" value={award.id} />
												<input type="hidden" name="decision" value="accepted" />
												<button class="button small">Verificado: aceptó</button>
											</form>
											<details>
												<summary class="small">Rechazó, no reclamó o no cumple</summary>
												<form method="POST" action="?/decide" class="stack">
													<input type="hidden" name="awardId" value={award.id} />
													<div class="field">
														<label for="decision-{award.id}">Decisión</label>
														<select id="decision-{award.id}" name="decision">
															<option value="declined">Rechazó o no reclamó en plazo</option>
															<option value="void">No cumple las condiciones (anular)</option>
														</select>
													</div>
													<div class="field">
														<label for="notes-{award.id}">Motivo</label>
														<textarea id="notes-{award.id}" name="notes" rows="2" minlength="5" required></textarea>
													</div>
													<button class="button secondary small">Registrar y pasar al siguiente</button>
												</form>
											</details>
										</div>
									{/if}

									{#if award.fulfillment}
										<p class="small">
											<strong>{fulfillmentLabel[award.fulfillment.status]}</strong>
											{#if award.fulfillment.status === 'scheduled' && award.fulfillment.scheduledFor}para el {dateTime(award.fulfillment.scheduledFor, timezone, 'short')}{/if}
											{#if award.fulfillment.deliveredAt}el {dateTime(award.fulfillment.deliveredAt, timezone, 'short')}{/if}
											{#if award.fulfillment.evidenceUrl}· <a href={award.fulfillment.evidenceUrl} target="_blank" rel="noopener nofollow">evidencia</a>{/if}
										</p>
										{#if award.fulfillment.notes}<p class="muted small">{award.fulfillment.notes}</p>{/if}
										{#if award.operable && fulfillmentOptions(award.fulfillment.status).length}
											<details>
												<summary class="small">Actualizar entrega</summary>
												<form method="POST" action="?/fulfill" class="stack">
													<input type="hidden" name="awardId" value={award.id} />
													<input type="hidden" name="timezone" value={timezone} />
													<div class="row">
														<div class="field">
															<label for="status-{award.id}">Estado</label>
															<select id="status-{award.id}" name="status">
																{#each fulfillmentOptions(award.fulfillment.status) as option (option)}
																	<option value={option}>{fulfillmentLabel[option]}</option>
																{/each}
															</select>
														</div>
														<div class="field">
															<label for="scheduled-{award.id}">Fecha coordinada ({timezone})</label>
															<input id="scheduled-{award.id}" name="scheduledFor" type="datetime-local" defaultValue={toLocalInput(award.fulfillment.scheduledFor, timezone)} />
														</div>
													</div>
													<div class="row">
														<div class="field">
															<label for="delivered-{award.id}">Fecha de entrega (si ya se entregó)</label>
															<input id="delivered-{award.id}" name="deliveredAt" type="datetime-local" />
														</div>
														<div class="field">
															<label for="evidence-{award.id}">Evidencia pública (https)</label>
															<input id="evidence-{award.id}" name="evidenceUrl" type="url" defaultValue={award.fulfillment.evidenceUrl ?? ''} />
														</div>
													</div>
													<div class="field">
														<label for="fnotes-{award.id}">Notas internas</label>
														<TextArea id="fnotes-{award.id}" name="notes" rows={2} value={award.fulfillment.notes ?? ''} />
													</div>
													<p class="hint">Una entrega registrada como entregada ya no se modifica. La evidencia se publica en la página de transparencia.</p>
													<button class="button small">Guardar entrega</button>
												</form>
											</details>
										{/if}
									{/if}
								</li>
							{/each}
						</ol>
					{/if}

					{#if slot.canRecord}
						<details open={slot.awards.length === 0}>
							<summary class="small">{slot.awards.length ? 'Corregir resultado' : 'Cargar resultado'}</summary>
							<form method="POST" action="?/record" class="stack">
								<input type="hidden" name="prizeId" value={prize.id} />
								<input type="hidden" name="slot" value={slot.slot} />
								<div class="numbers">
									<div class="field">
										<label for="winner-{prize.id}-{slot.slot}">Ganador, n.º</label>
										<input id="winner-{prize.id}-{slot.slot}" name="winner" inputmode="numeric" required placeholder={padEntryNumber(0, digits)} defaultValue={typed(slot.awards.find((award) => award.role === 'winner')?.entryNumber)} />
									</div>
									{#each Array.from({ length: prize.alternatesCount }, (_, index) => index + 1) as rank (rank)}
										<div class="field">
											<label for="alt-{prize.id}-{slot.slot}-{rank}">Suplente {rank}, n.º</label>
											<input
												id="alt-{prize.id}-{slot.slot}-{rank}"
												name="alternate"
												inputmode="numeric"
												defaultValue={typed(slot.awards.find((award) => award.role === 'alternate' && award.rank === rank)?.entryNumber)}
											/>
										</div>
									{/each}
								</div>
								<div class="field">
									<label for="rnotes-{prize.id}-{slot.slot}">Referencia en el acta (opcional)</label>
									<input id="rnotes-{prize.id}-{slot.slot}" name="notes" placeholder="Extracción 3, acta 12/2026" />
								</div>
								<button class="button small secondary">Guardar resultado</button>
							</form>
						</details>
					{/if}
				</article>
			{/each}
		</div>
	</section>
{/each}

<style>
	.head {
		margin: 0.75rem 0 1.25rem;
		display: grid;
		gap: 0.4rem;
	}

	h1 {
		font-size: var(--step-4);
		text-transform: uppercase;
	}

	h2 {
		font-size: var(--step-1);
		text-transform: uppercase;
	}

	h3 {
		font-size: var(--step-0);
	}

	.panel {
		margin-block: 1rem;
		display: grid;
		gap: 0.75rem;
	}

	.slots {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
		gap: 0.75rem;
	}

	.slot {
		display: grid;
		gap: 0.6rem;
		align-content: start;
		padding: 1rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		background: var(--surface-2);
	}

	.slot-head {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 0.5rem;
	}

	.awards {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 0.5rem;
	}

	.awards li {
		display: grid;
		gap: 0.35rem;
		padding: 0.6rem 0.75rem;
		border-radius: var(--radius-sm);
		border: 1px solid transparent;
	}

	.awards li.active {
		border-color: var(--accent);
		background: var(--surface);
	}

	.who {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem 0.75rem;
		align-items: baseline;
	}

	.label {
		font-weight: 700;
	}

	.number {
		font-variant-numeric: tabular-nums;
		font-weight: 600;
	}

	.actions {
		display: grid;
		gap: 0.5rem;
		justify-items: start;
	}

	.stack {
		display: grid;
		gap: 0.6rem;
		margin-top: 0.6rem;
	}

	.extracts {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(6.5rem, 1fr));
		gap: 0.35rem 0.75rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.preview {
		display: grid;
		gap: 0.75rem;
		padding-top: 0.75rem;
		border-top: 1px solid var(--border);
	}

	.extract-table {
		width: 100%;
		border-collapse: collapse;
	}

	.extract-table th,
	.extract-table td {
		text-align: start;
		padding: 0.4rem 0.5rem;
		border-bottom: 1px solid var(--border);
	}

	.outcomes {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 0.4rem;
	}

	.outcomes li {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem 0.75rem;
		align-items: baseline;
	}

	.row,
	.numbers {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
		gap: 0.6rem;
	}

	summary {
		cursor: pointer;
		font-weight: 600;
	}

	.small {
		font-size: var(--step--1);
	}
</style>
