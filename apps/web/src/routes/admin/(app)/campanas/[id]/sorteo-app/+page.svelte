<script lang="ts">
	import { onDestroy, onMount, tick } from 'svelte';
	import { enhance } from '$app/forms';
	import { goto } from '$app/navigation';
	import AppDrawReel from '#lib/components/AppDrawReel.svelte';
	import Confetti from '#lib/components/Confetti.svelte';
	import DrawTally from './DrawTally.svelte';
	import {
		REEL_MAX_SPEED,
		displayOrder,
		pickAnnouncement,
		pickRole,
		picksNeedUnit,
		planSpin,
		reelStrip,
		rowLabel,
		shortHash,
		spinAnnouncement,
		spinPosition,
		spinVelocity,
		type AppDrawCandidate,
		type AppDrawPick,
		type AppDrawResult,
		type SpinPlan
	} from '#lib/app-draw.js';
	import { createDrawSound, storedMuted, storeMuted, type DrawSound } from '#lib/app-draw-sound.js';
	import { dateTime } from '#lib/format.js';
	import type { PageProps } from './$types';

	// ADR 0024 §5 (odd/tasks/owner-feedback-2026-11-11b.md S10, L14): the screen shown on the
	// live stream. The API draws and stores the result first; this page only reveals it.
	let { data, form }: PageProps = $props();
	type Phase = 'idle' | 'drawing' | 'spinning' | 'landed' | 'summary';

	const view = $derived(data.view);
	const preview = $derived(view.state === 'ready' ? view.preview : null);
	const formResult = $derived(form && 'result' in form ? (form.result as AppDrawResult) : null);
	let result = $derived<AppDrawResult | null>(formResult ?? (view.state === 'drawn' ? view.result : null));
	let replayed = $derived(Boolean(form && 'created' in form && form.created === false));
	let failure = $derived(form && 'message' in form ? String(form.message) : null);
	let phase = $derived<Phase>(result ? 'summary' : 'idle');
	let confirming = $derived(data.confirming && !result);

	const campaign = $derived(result?.campaign ?? preview?.campaign ?? null);
	const hash = $derived(result?.candidateSha256 ?? preview?.candidateSha256 ?? null);
	const candidateCount = $derived(result?.candidateCount ?? preview?.candidateCount ?? 0);
	const number = new Intl.NumberFormat('es-AR');
	const withUnit = $derived(picksNeedUnit(result?.picks ?? preview?.vacant ?? []));
	const prizeLabel = (pick: Pick<AppDrawPick, 'prizeTitle' | 'slot'>) => `${pick.prizeTitle}${withUnit ? `, unidad ${pick.slot}` : ''}`;
	const backHref = $derived(`/admin/campanas/${campaign?.id ?? ''}/premios`);

	// The reel: before the draw it drifts through every candidate; during a pick it spins to it.
	let strip = $state<AppDrawCandidate[]>([]);
	let position = $state(0);
	let index = $state(0);
	const pick = $derived(result && phase !== 'summary' ? (result.picks[index] ?? null) : null);
	const nextPick = $derived(result ? (result.picks[index + 1] ?? null) : null);
	let live = $state('');
	let burst = $state(0);
	let copied = $state(false);

	let stage: HTMLElement | undefined = $state();
	let nextButton: HTMLButtonElement | undefined = $state();
	let fullscreen = $state(false);
	let reduced = $state(false);
	let muted = $state(false);
	let sound: DrawSound | null = null;
	let frame = 0;

	onMount(() => {
		reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
		// With reduced motion there is no sound unless someone turned it on.
		muted = storedMuted(localStorage) ?? reduced;
		const onFullscreen = () => (fullscreen = Boolean(document.fullscreenElement));
		document.addEventListener('fullscreenchange', onFullscreen);
		if (preview && phase === 'idle') idle(preview.candidates, preview.candidateSha256);
		return () => document.removeEventListener('fullscreenchange', onFullscreen);
	});

	onDestroy(() => {
		if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
		sound?.close();
	});

	function idle(candidates: AppDrawCandidate[], seed: string) {
		strip = displayOrder(candidates.length, seed).map((position) => candidates[position]!);
		if (reduced) return;
		let last = performance.now();
		const drift = (now: number) => {
			position += ((now - last) / 1000) * 1.5;
			last = now;
			frame = requestAnimationFrame(drift);
		};
		frame = requestAnimationFrame(drift);
	}

	/** Audio may only start from a click: called by "Confirmar y sortear" and "Ver la animación". */
	function ensureSound() {
		sound ??= createDrawSound(muted);
	}

	function toggleSound() {
		muted = !muted;
		storeMuted(localStorage, muted);
		ensureSound();
		sound?.setMuted(muted);
	}

	async function toggleFullscreen() {
		if (document.fullscreenElement) await document.exitFullscreen();
		else await stage?.requestFullscreen?.();
	}

	async function copyHash() {
		if (!hash) return;
		await navigator.clipboard.writeText(hash);
		copied = true;
		setTimeout(() => (copied = false), 2000);
	}

	function play(drawn: AppDrawResult, at: number) {
		cancelAnimationFrame(frame);
		sound?.stopTension();
		const current = drawn.picks[at]!;
		const reel = reelStrip(drawn.candidates, drawn.picks, at, drawn.candidateSha256);
		index = at;
		strip = reel.strip;
		if (reduced) {
			position = reel.target;
			land(current);
			return;
		}
		phase = 'spinning';
		// Kept until `land` replaces it with the result.
		live = spinAnnouncement(current, withUnit);
		const plan: SpinPlan = planSpin({ length: reel.strip.length, target: reel.target, kind: current.role });
		const decelAt = plan.accel + plan.cruise;
		let tense = false;
		let centre = Math.round(plan.start);
		position = plan.start;
		const started = performance.now();
		const step = (now: number) => {
			const t = (now - started) / 1000;
			position = spinPosition(plan, t);
			const row = Math.round(position);
			if (row !== centre) {
				centre = row;
				sound?.tick(spinVelocity(plan, t) / REEL_MAX_SPEED);
			}
			if (!tense && t >= decelAt) {
				tense = true;
				sound?.tension(plan.decel);
			}
			if (t >= plan.duration) {
				position = plan.start + plan.distance;
				land(current);
				return;
			}
			frame = requestAnimationFrame(step);
		};
		frame = requestAnimationFrame(step);
	}

	async function land(current: AppDrawPick) {
		phase = 'landed';
		live = pickAnnouncement(current, withUnit);
		sound?.stopTension();
		sound?.fanfare();
		if (!reduced) burst += 1;
		await tick();
		nextButton?.focus();
	}

	function next() {
		if (!result) return;
		if (index + 1 < result.picks.length) play(result, index + 1);
		else {
			phase = 'summary';
			live = 'Terminó el sorteo de los premios vacantes.';
		}
	}

	function replay() {
		if (!result) return;
		ensureSound();
		play(result, 0);
	}

	const confettiColors = ['#F5F7FB', '#14161B', 'var(--accent)'];
	// Canvas fill styles do not resolve CSS variables: read the tenant accent once on the client.
	let accent = $state('#F04438');
	onMount(() => {
		accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || accent;
	});
	const colors = $derived(confettiColors.map((color) => (color === 'var(--accent)' ? accent : color)));
</script>

<svelte:head>
	<title>Sorteo en la app | {campaign?.title ?? 'Premios vacantes'}</title>
</svelte:head>

<div class="stage" class:fullscreen bind:this={stage}>
	<header class="bar">
		<div class="ident">
			{#if campaign}<p class="campaign">{campaign.title}{campaign.round > 1 ? `, ronda ${campaign.round}` : ''}</p>{/if}
			<h1>Sorteo de los premios vacantes</h1>
		</div>
		<div class="controls">
			<button type="button" class="control" aria-pressed={!muted} onclick={toggleSound}>
				<span class="sound-icon" class:off={muted} aria-hidden="true"></span>Sonido
			</button>
			<button type="button" class="control" onclick={toggleFullscreen}>{fullscreen ? 'Salir de pantalla completa' : 'Pantalla completa'}</button>
			{#if !fullscreen}<a class="control" href={backHref}>Volver a premios</a>{/if}
		</div>
	</header>

	<div class="floor">
		{#if view.state === 'unavailable' && !result}
			<div class="message">
				<p class="lede">{view.message}</p>
				<a class="go small" href={backHref}>Volver a premios y entregas</a>
			</div>
		{:else if (phase === 'idle' || phase === 'drawing') && preview}
			<div class="before">
				<section class="brief" aria-labelledby="vacant-title">
					<h2 id="vacant-title" class="label">{preview.vacant.length === 1 ? 'Premio vacante' : 'Premios vacantes'}</h2>
					<ul class="prizes">
						{#each preview.vacant as vacant (`${vacant.prizeId}-${vacant.slot}`)}
							<li>
								<span class="prize">{prizeLabel(vacant)}</span>
								{#if vacant.alternatesCount}<span class="muted">y {vacant.alternatesCount === 1 ? '1 suplente' : `${vacant.alternatesCount} suplentes`}</span>{/if}
							</li>
						{/each}
					</ul>
					<p class="count"><strong>{number.format(preview.candidateCount)}</strong> {preview.candidateCount === 1 ? 'cupón sin premio participa' : 'cupones sin premio participan'}</p>
					<p class="muted">La plataforma elige con un número aleatorio criptográfico y guarda el resultado antes de mostrarlo.</p>

					{#if failure}<p class="notice error" role="alert">{failure}</p>{/if}
					{#if confirming}
						<form
							method="POST"
							action="?/sortear"
							class="confirm"
							use:enhance={() => {
								ensureSound();
								phase = 'drawing';
								failure = null;
								live = 'Sorteando…';
								return async ({ result: response }) => {
									if (response.type === 'success' && response.data?.result) {
										cancelAnimationFrame(frame);
										result = response.data.result as AppDrawResult;
										replayed = response.data.created === false;
										confirming = false;
										play(result, 0);
									} else if (response.type === 'failure') {
										phase = 'idle';
										failure = String(response.data?.message ?? 'No se pudo sortear');
									} else if (response.type === 'redirect') {
										await goto(response.location);
									} else {
										phase = 'idle';
										failure = 'No se pudo sortear. Probá de nuevo';
									}
								};
							}}
						>
							<p>
								Vas a sortear {preview.vacant.length === 1 ? 'el premio vacante' : `los ${preview.vacant.length} premios vacantes`} entre {number.format(preview.candidateCount)}
								{preview.candidateCount === 1 ? 'cupón' : 'cupones'}. El resultado se guarda al instante. No se puede deshacer.
							</p>
							<div class="row">
								<button class="go" disabled={phase === 'drawing'}>{phase === 'drawing' ? 'Sorteando…' : 'Confirmar y sortear'}</button>
								<a
									class="control"
									href="?"
									onclick={(event) => {
										event.preventDefault();
										confirming = false;
									}}>Cancelar</a
								>
							</div>
						</form>
					{:else}
						<a
							class="go"
							href="?confirmar"
							onclick={(event) => {
								event.preventDefault();
								confirming = true;
							}}>Sortear</a
						>
					{/if}
				</section>
				<div class="idle-reel">
					<AppDrawReel {strip} {position} />
				</div>
			</div>
		{:else if result && (phase === 'spinning' || phase === 'landed') && pick}
			<div class="drawing">
				<div class="draw">
					<div class="heading">
						<p class="role">{pickRole(pick)}</p>
						<h2 class="prize-title">{prizeLabel(pick)}</h2>
					</div>
					<div class="reel-area">
						<AppDrawReel {strip} {position} landed={phase === 'landed'} />
						{#if phase === 'landed'}
							<div class="winner" class:alternate={pick.role === 'alternate'}>
								<p class="winner-role">{pickRole(pick)}</p>
								<p class="winner-number">{pick.entryNumber}</p>
								<p class="winner-name">{pick.maskedName}</p>
								<p class="winner-prize">{prizeLabel(pick)}</p>
							</div>
						{/if}
					</div>
					<div class="after">
						{#if phase === 'landed'}
							<button type="button" class="go next" bind:this={nextButton} onclick={next}>
								{nextPick ? `Siguiente: ${pickRole(nextPick)} del ${prizeLabel(nextPick)}` : 'Ver todos los resultados'}
							</button>
						{:else}
							<p class="muted">Pasan los {number.format(strip.length)} cupones en juego.</p>
						{/if}
					</div>
				</div>
				<DrawTally picks={result.picks} {index} landed={phase === 'landed'} {prizeLabel} />
			</div>
		{:else if result}
			<section class="summary" aria-labelledby="summary-title">
				{#if replayed}<p class="notice">Este sorteo ya se había hecho: se muestra el resultado guardado.</p>{/if}
				<h2 id="summary-title">Resultado del sorteo</h2>
				<p class="muted">Sorteado el {dateTime(result.drawnAt, result.campaign.timezone)} entre {number.format(result.candidateCount)} cupones sin premio.</p>
				<ol class="results">
					{#each result.picks as drawn, order (order)}
						<li class:winner-row={drawn.role === 'winner'}>
							<span class="result-role">{pickRole(drawn)}</span>
							<span class="result-coupon">{rowLabel(drawn)}</span>
							<span class="result-prize">{prizeLabel(drawn)}</span>
						</li>
					{/each}
				</ol>
				<div class="row">
					<button type="button" class="go" onclick={replay}>Ver la animación</button>
					<a class="control" href={backHref}>Volver a premios y entregas</a>
				</div>
			</section>
		{/if}
	</div>

	{#if hash}
		<footer class="proof">
			<span>{number.format(candidateCount)} {candidateCount === 1 ? 'cupón sin premio' : 'cupones sin premio'}</span>
			<span class="hash" title={hash}>SHA-256 de la lista: {shortHash(hash)}</span>
			<button type="button" class="control small" onclick={copyHash}>{copied ? 'Copiado' : 'Copiar SHA-256'}</button>
		</footer>
	{/if}

	<p id="app-draw-live" class="visually-hidden" aria-live="polite" aria-atomic="true">{live}</p>
	<Confetti {burst} pieces={pick?.role === 'alternate' ? 70 : 200} {colors} />
</div>

<style>
	/*
	 * Shown on the live stream: always the dark stage, whatever the panel theme.
	 * Asphalt with a finish line at the centre of the reel; the tenant's display
	 * font and accent carry the brand.
	 */
	.stage {
		--stage-bg: #121418;
		--stage-ink: #1c1f26;
		--stage-text: #f5f7fb;
		--stage-muted: #8d96a6;
		position: fixed;
		inset: 0;
		z-index: 50;
		display: grid;
		grid-template-rows: auto minmax(0, 1fr) auto;
		background:
			radial-gradient(ellipse at 50% 55%, color-mix(in srgb, var(--accent) 10%, transparent), transparent 60%),
			var(--stage-bg);
		color: var(--stage-text);
		overflow: hidden;
	}

	.bar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem 1.5rem;
		padding: clamp(0.75rem, 0.5rem + 1vw, 1.5rem) clamp(1rem, 0.5rem + 2vw, 2.5rem);
	}

	.campaign {
		color: var(--stage-muted);
		font-weight: 600;
	}

	h1 {
		font-size: var(--step-2);
	}

	.controls,
	.row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.6rem;
	}

	.control {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.55rem 0.95rem;
		border: 1px solid color-mix(in srgb, var(--stage-text) 28%, transparent);
		border-radius: 999px;
		background: transparent;
		color: var(--stage-text);
		font: 600 var(--step--1) / 1.2 var(--font-body);
		text-decoration: none;
		cursor: pointer;
	}

	.control:hover {
		border-color: var(--stage-text);
	}

	.control[aria-pressed='false'] {
		color: var(--stage-muted);
	}

	.sound-icon {
		width: 0.9rem;
		height: 0.9rem;
		border-radius: 50%;
		background: var(--accent);
	}

	.sound-icon.off {
		background: transparent;
		box-shadow: inset 0 0 0 2px var(--stage-muted);
	}

	.go {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-height: 3.5rem;
		padding: 0.8rem 2.4rem;
		border: 0;
		border-radius: 999px;
		background: var(--accent);
		color: var(--accent-text, #fff);
		font: 800 var(--step-2) / 1 var(--font-display);
		letter-spacing: 0.02em;
		text-decoration: none;
		cursor: pointer;
	}

	.go.small {
		font-size: var(--step-1);
		min-height: 3rem;
	}

	.go[disabled] {
		opacity: 0.7;
		cursor: progress;
	}

	.floor {
		min-height: 0;
		display: grid;
		padding-inline: clamp(1rem, 0.5rem + 2vw, 2.5rem);
	}

	.message {
		align-self: center;
		justify-self: center;
		display: grid;
		gap: 1.5rem;
		justify-items: start;
		max-width: 40ch;
	}

	.lede {
		font: 800 var(--step-3) / 1.1 var(--font-display);
	}

	.muted {
		color: var(--stage-muted);
	}

	.before {
		display: grid;
		grid-template-columns: minmax(0, 0.9fr) minmax(0, 1.1fr);
		gap: clamp(1rem, 3vw, 4rem);
		min-height: 0;
	}

	.brief {
		align-self: center;
		display: grid;
		gap: 1.1rem;
		justify-items: start;
		max-width: 34rem;
	}

	.label {
		font-size: var(--step-1);
		color: var(--stage-muted);
	}

	.prizes {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 0.35rem;
	}

	.prizes li {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 0.25rem 0.75rem;
	}

	.prize {
		font: 800 var(--step-4) / 1 var(--font-display);
	}

	.count {
		font-size: var(--step-1);
		font-weight: 600;
	}

	.count strong {
		font: 800 var(--step-5) / 0.9 var(--font-display);
		font-variant-numeric: tabular-nums;
		color: var(--accent);
		margin-right: 0.15em;
	}

	.confirm {
		display: grid;
		gap: 1rem;
		padding: 1.25rem;
		border-left: 4px solid var(--accent);
		background: var(--stage-ink);
		max-width: 34rem;
	}

	.idle-reel {
		position: relative;
		min-height: 0;
		height: 100%;
	}

	/* The reel and, once it stops, the winner card share one cell: the card sits over the reel, inside it. */
	.reel-area {
		position: relative;
		min-height: 0;
		display: grid;
		grid-template: minmax(0, 1fr) / minmax(0, 1fr);
	}

	.reel-area > :global(*) {
		grid-area: 1 / 1;
	}

	/* The reel keeps the focus; the side table of every pick sits to its right (S3, owner-feedback-2026-11-12). */
	.drawing {
		display: grid;
		grid-template-columns: minmax(0, 1fr) clamp(15rem, 26vw, 28rem);
		gap: clamp(1rem, 2vw, 2.5rem);
		min-height: 0;
		padding-bottom: 1rem;
	}

	.draw {
		display: grid;
		grid-template-rows: auto minmax(0, 1fr) auto;
		min-height: 0;
		justify-items: stretch;
		text-align: center;
	}

	.heading {
		display: grid;
		gap: 0.25rem;
	}

	.role {
		font-weight: 700;
		color: var(--accent);
		font-size: var(--step-1);
	}

	/* Sized from the height too, so at 720p the reel keeps most of the screen. */
	.prize-title {
		font-size: clamp(1.6rem, min(6vh, 7vw), 4.2rem);
	}

	/* The result: the centre row grows into the winner card, once, without blinking. */
	/* Every size follows the viewport height (and width on phones), so the card fits the reel cell. */
	.winner {
		position: relative;
		z-index: 1;
		place-self: center;
		max-width: 100%;
		display: grid;
		justify-items: center;
		gap: 0.3rem;
		padding: clamp(0.75rem, 2.5vh, 2.5rem) clamp(1.25rem, 5vw, 4.5rem);
		background: var(--stage-bg);
		border: 0.4rem solid var(--accent);
		box-shadow: 0 0 0 100vmax color-mix(in srgb, var(--stage-bg) 55%, transparent);
		animation: arrive 0.7s var(--ease-out) both;
	}

	.winner-role {
		font-weight: 800;
		font-size: clamp(1.1rem, 3.4vh, 2.2rem);
		color: var(--accent);
	}

	.winner-number {
		font: 800 clamp(3.5rem, min(17vh, 24vw), 14rem) / 0.9 var(--font-display);
		font-variant-numeric: tabular-nums;
		letter-spacing: 0.03em;
	}

	.winner-name {
		font: 800 clamp(1.6rem, min(6vh, 9vw), 4.5rem) / 1 var(--font-display);
	}

	.winner-prize {
		font-size: clamp(1rem, 3.2vh, 2rem);
		font-weight: 600;
		color: var(--stage-muted);
	}

	.winner.alternate .winner-number {
		font-size: clamp(3rem, min(13vh, 20vw), 10rem);
	}

	@keyframes arrive {
		from {
			opacity: 0;
			scale: 0.55;
		}
	}

	/* Above the card's dimming, always fully visible and clickable. */
	.after {
		position: relative;
		z-index: 2;
		display: flex;
		justify-content: center;
		padding-block: 1rem;
		min-height: 5.5rem;
		align-items: center;
	}

	.go.next {
		max-width: 100%;
		font-size: clamp(1.1rem, 3.4vh, 1.9rem);
		line-height: 1.15;
		text-align: center;
	}

	.summary {
		align-self: center;
		justify-self: center;
		display: grid;
		gap: 1rem;
		width: min(100%, 56rem);
	}

	.summary h2 {
		font-size: var(--step-4);
	}

	.results {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
	}

	.results li {
		display: grid;
		grid-template-columns: 9rem minmax(0, 1fr) minmax(0, 1fr);
		gap: 1rem;
		align-items: baseline;
		padding-block: 0.7rem;
		border-top: 1px solid color-mix(in srgb, var(--stage-text) 14%, transparent);
	}

	.result-role {
		color: var(--stage-muted);
		font-weight: 700;
	}

	.winner-row .result-role {
		color: var(--accent);
	}

	.result-coupon {
		font: 800 var(--step-3) / 1 var(--font-display);
		font-variant-numeric: tabular-nums;
	}

	.notice {
		padding: 0.75rem 1rem;
		border-left: 4px solid var(--stage-muted);
		background: var(--stage-ink);
		color: var(--stage-text);
	}

	.notice.error {
		border-color: var(--danger, #f04438);
	}

	.proof {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem 1.5rem;
		padding: 0.75rem clamp(1rem, 0.5rem + 2vw, 2.5rem);
		border-top: 1px solid color-mix(in srgb, var(--stage-text) 12%, transparent);
		color: var(--stage-muted);
		font-size: var(--step--1);
	}

	.hash {
		font-variant-numeric: tabular-nums;
		color: var(--stage-text);
	}

	.small {
		font-size: var(--step--1);
	}

	@media (max-width: 860px) {
		.before {
			grid-template-columns: 1fr;
			grid-template-rows: auto minmax(16rem, 1fr);
			overflow: auto;
		}

		.results li {
			grid-template-columns: 1fr;
			gap: 0.2rem;
		}

		/*
		 * Narrow screens keep the whole height for the reel and the winner card: the stream is a wide
		 * screen, and below the reel the table pushed the card over the prize title. The summary lists
		 * every pick at the end.
		 */
		.drawing {
			grid-template-columns: minmax(0, 1fr);
		}

		.drawing :global(.tally) {
			display: none;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.winner {
			animation: fade 0.4s linear both;
		}

		@keyframes fade {
			from {
				opacity: 0;
			}
		}
	}
</style>
