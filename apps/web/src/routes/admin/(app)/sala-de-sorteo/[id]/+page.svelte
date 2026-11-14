<script lang="ts">
	import { couponParseMessage, parseCouponNumber } from '@sortea/domain';
	import { onDestroy, onMount, tick } from 'svelte';
	import { deserialize } from '$app/forms';
	import { goto, invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import AppDrawReel from '#lib/components/AppDrawReel.svelte';
	import Confetti from '#lib/components/Confetti.svelte';
	import DateField from '#lib/components/DateField.svelte';
	import {
		REEL_MAX_SPEED,
		displayOrder,
		pickAnnouncement,
		planSpin,
		reelStrip,
		spinAnnouncement,
		spinPosition,
		spinVelocity,
		type AppDrawCandidate,
		type AppDrawPick,
		type AppDrawPreview,
		type SpinPlan
	} from '#lib/app-draw.js';
	import { createDrawSound, storedMuted, storeMuted, type DrawSound } from '#lib/app-draw-sound.js';
	import { autoSubmitReady, lookupView, type CouponLookup } from '#lib/coupon-lookup.js';
	import {
		BROADCAST_PARAM,
		DEFAULT_QUINIELA_SOURCE,
		DRAND_POLL_MS,
		EXTRACT_COUNT,
		appPrizeRows,
		awardOrderLabel,
		candidatesLabel,
		draftKey,
		drawConfirmText,
		drawStep,
		emptyExtracts,
		extractInput,
		extractRows,
		onAirHash,
		parseDraft,
		positionAfterInput,
		positionAfterKey,
		prizeDrawPicks,
		prizeTiradaRows,
		recordedExtractRows,
		showQuinielaEntry,
		storeDraft,
		tableProgress,
		tiradaPick,
		typedPrefix,
		unitLabel,
		unitRows,
		unitsLabel,
		waitingText,
		type AppPrizeDrawResult,
		type AppPrizeRow,
		type DrawRoomTiradaResult,
		type QuinielaLivePreview,
		type UnitRow
	} from '#lib/draw-room.js';
	import { campaignStatusLabel, dateTime } from '#lib/format.js';
	import AppPrizeList from './AppPrizeList.svelte';
	import ExtractGrid from './ExtractGrid.svelte';
	import UnitTable from './UnitTable.svelte';
	import type { PageProps } from './$types';

	// odd/tasks/draw-room.md T5 (S3, S4, L1): the screen the draw host runs the live draw on.
	let { data }: PageProps = $props();
	const room = $derived(data.room);
	const campaign = $derived(room.campaign);
	let broadcast = $derived(data.broadcast);
	const status = $derived(campaignStatusLabel[campaign.status] ?? { label: campaign.status, tone: 'neutral' as const });

	// T9 (S6): the `app` prizes are the main area; the Quiniela entry only while Quiniela prizes remain.
	const prizeRows = $derived(appPrizeRows(room));
	const hasAppPrizes = $derived(prizeRows.length > 0);
	const hasQuiniela = $derived(showQuinielaEntry(room));
	const hasUnitTable = $derived(room.prizes.some((prize) => prize.mechanism !== 'app'));
	const prizeTiradas = $derived(prizeTiradaRows(room));

	// ─── Live Quiniela entry ────────────────────────────────────────────────
	const entryOpen = $derived(hasQuiniela && campaign.status === 'awarding' && Boolean(room.manifest?.publishedAt) && !room.quinielaDraw);
	let values = $state<string[]>(emptyExtracts());
	let source = $state(DEFAULT_QUINIELA_SOURCE);
	let drawDate = $state('');
	let drawTime = $state('');
	let evidenceUrl = $state('');
	let restored = $state(0);
	let preview = $state<QuinielaLivePreview | null>(null);
	let liveError = $state<string | null>(null);
	let review = $state<QuinielaLivePreview | null>(null);
	let recordError = $state<string | null>(null);
	let recording = $state(false);
	const storageKey = $derived(draftKey(campaign.id, campaign.round));
	const prefix = $derived(typedPrefix(values));
	const complete = $derived(prefix.length === EXTRACT_COUNT);
	const prizeLabel = (prizeId: string, slot: number) => {
		const prize = room.prizes.find((candidate) => candidate.id === prizeId);
		return prize ? unitLabel(prize, slot) : '';
	};
	const rows = $derived(room.quinielaDraw ? recordedExtractRows(room) : extractRows(values, preview, prizeLabel));
	const units = $derived(unitRows(room, room.quinielaDraw ? null : preview));

	onMount(() => {
		if (!entryOpen) {
			localStorage.removeItem(storageKey);
			return;
		}
		const draft = parseDraft(localStorage.getItem(storageKey));
		values = draft.extracts;
		source = draft.source;
		drawDate = draft.drawDate;
		drawTime = draft.drawTime;
		evidenceUrl = draft.evidenceUrl;
		restored += 1;
		void match();
	});

	function save() {
		storeDraft(localStorage, storageKey, { extracts: values, source, drawDate, drawTime, evidenceUrl });
	}

	/**
	 * Calls an action of this page and returns what it answered; a redirect (session over) is followed.
	 * A refusal carries its HTTP status; `status: 0` means no answer at all (connection lost).
	 */
	async function act<T>(name: string, fields: Record<string, string>): Promise<{ ok: true; data: T } | { ok: false; message: string; status: number; transient: boolean }> {
		const body = new FormData();
		for (const [key, value] of Object.entries(fields)) body.set(key, value);
		try {
			const response = await fetch(`?/${name}`, { method: 'POST', body, headers: { 'x-sveltekit-action': 'true', accept: 'application/json' } });
			const result = deserialize(await response.text());
			if (result.type === 'success') return { ok: true, data: (result.data ?? {}) as T };
			if (result.type === 'failure') return { ok: false, message: String(result.data?.message ?? 'No se pudo completar'), status: result.status, transient: result.data?.transient === true };
			if (result.type === 'redirect') await goto(result.location);
			return { ok: false, message: 'No se pudo completar. Probá de nuevo', status: response.status, transient: false };
		} catch {
			return { ok: false, message: 'Sin conexión con el panel. Probá de nuevo', status: 0, transient: true };
		}
	}

	let asked = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	/** The matches of the numbers typed so far, from the server; an answer older than the latest question is dropped. */
	async function match() {
		const question = ++asked;
		const typed = typedPrefix(values);
		if (typed.length === 0) {
			preview = null;
			liveError = null;
			return;
		}
		const answer = await act<{ preview: QuinielaLivePreview | null }>('coincidencias', { extracts: JSON.stringify(values) });
		if (question !== asked) return;
		if (answer.ok) {
			preview = answer.data.preview;
			liveError = null;
		} else liveError = answer.message;
	}

	function onExtractInput(index: number, raw: string) {
		const value = extractInput(raw);
		values[index] = value;
		const input = document.getElementById(`extract-${index + 1}`) as HTMLInputElement | null;
		if (input && input.value !== value) input.value = value;
		review = null;
		save();
		clearTimeout(timer);
		timer = setTimeout(match, 120);
		const next = positionAfterInput(index, value);
		if (next !== null) focusExtract(next);
	}

	function onExtractKey(index: number, event: KeyboardEvent) {
		const next = positionAfterKey(index, event.key, values[index] ?? '');
		if (event.key === 'Enter') event.preventDefault();
		if (next === null) return;
		if (event.key === 'Backspace') event.preventDefault();
		focusExtract(next);
	}

	function focusExtract(index: number) {
		const input = document.getElementById(`extract-${index + 1}`) as HTMLInputElement | null;
		input?.focus();
		input?.select();
	}

	function onDetails(event: Event) {
		const target = event.target as HTMLInputElement;
		if (target.name === 'drawDate') drawDate = target.value;
		else if (target.name === 'drawTime') drawTime = target.value;
		review = null;
		save();
	}

	const drawFields = () => ({ extracts: JSON.stringify(values), source, drawDate, drawTime, evidenceUrl, timezone: campaign.timezone });

	async function askReview() {
		recordError = null;
		recording = true;
		const answer = await act<{ review: QuinielaLivePreview }>('revisar', drawFields());
		recording = false;
		if (!answer.ok) {
			recordError = answer.message;
			return;
		}
		review = answer.data.review;
		await tick();
		document.getElementById('record-confirm')?.focus();
	}

	async function record() {
		if (!review?.digest) return;
		recordError = null;
		recording = true;
		const answer = await act<{ recorded: boolean }>('registrar', { ...drawFields(), digest: review.digest });
		recording = false;
		if (!answer.ok) {
			recordError = answer.message;
			review = null;
			return;
		}
		localStorage.removeItem(storageKey);
		review = null;
		preview = null;
		live = 'Los 20 números quedaron registrados.';
		await invalidateAll();
	}

	const reviewWinners = $derived(review ? review.slots.filter((slot) => slot.winner).length : 0);

	// ─── In-app tiradas ─────────────────────────────────────────────────────
	type Phase = 'confirm' | 'drawing' | 'spinning' | 'landed';
	let stage = $state<{ phase: Phase; row: Pick<UnitRow, 'prizeId' | 'slot' | 'label'>; replay: boolean } | null>(null);
	let pool = $state<AppDrawPreview | null>(null);
	let drawError = $state<string | null>(null);
	let tirada = $state<DrawRoomTiradaResult | null>(null);
	let strip = $state<AppDrawCandidate[]>([]);
	let position = $state(0);
	let burst = $state(0);
	let live = $state('');
	let reduced = $state(false);
	let muted = $state(false);
	let sound: DrawSound | null = null;
	let frame = 0;
	let backButton: HTMLButtonElement | undefined = $state();

	onMount(() => {
		reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
		muted = storedMuted(localStorage) ?? reduced;
	});

	onDestroy(() => {
		destroyed = true;
		clearTimeout(timer);
		clearTimeout(prizeTimer);
		clearTimeout(peekTimer);
		if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
		sound?.close();
	});

	function ensureSound() {
		sound ??= createDrawSound(muted);
	}

	function toggleSound() {
		muted = !muted;
		storeMuted(localStorage, muted);
		ensureSound();
		sound?.setMuted(muted);
	}

	function drift(candidates: AppDrawCandidate[], seed: string) {
		strip = displayOrder(candidates.length, seed).map((index) => candidates[index]!);
		position = 0;
		if (reduced) return;
		let last = performance.now();
		const step = (now: number) => {
			position += ((now - last) / 1000) * 1.5;
			last = now;
			frame = requestAnimationFrame(step);
		};
		frame = requestAnimationFrame(step);
	}

	/** "Sortear esta posición": the coupons in play first, then a confirmation. Nothing is drawn yet. */
	async function chooseUnit(row: UnitRow) {
		drawError = null;
		tirada = null;
		pool = null;
		stage = { phase: 'confirm', row, replay: false };
		const answer = await act<{ candidates: AppDrawPreview }>('candidatos', {});
		if (!stage || stage.phase !== 'confirm') return;
		if (!answer.ok) {
			drawError = answer.message;
			return;
		}
		pool = answer.data.candidates;
		drift(pool.candidates, pool.candidateSha256);
		await tick();
		document.getElementById('draw-confirm')?.focus();
	}

	async function drawUnit() {
		if (!stage) return;
		ensureSound();
		drawError = null;
		stage.phase = 'drawing';
		live = 'Sorteando…';
		const answer = await act<{ tirada: DrawRoomTiradaResult }>('sortear', { prizeId: stage.row.prizeId, slot: String(stage.row.slot) });
		if (!answer.ok) {
			stage.phase = 'confirm';
			drawError = answer.message;
			live = '';
			return;
		}
		play(answer.data.tirada);
	}

	async function replay(sequence: number) {
		ensureSound();
		drawError = null;
		const answer = await act<{ tirada: DrawRoomTiradaResult }>('tirada', { sequence: String(sequence) });
		if (!answer.ok) {
			live = answer.message;
			return;
		}
		const result = answer.data.tirada;
		stage = { phase: 'drawing', row: { prizeId: result.prizeId, slot: result.slot, label: tiradaUnit(result) }, replay: true };
		play(result);
	}

	const tiradaUnit = (row: { prizeId: string; slot: number; prizeTitle: string }) => prizeLabel(row.prizeId, row.slot) || row.prizeTitle;

	function play(result: DrawRoomTiradaResult) {
		cancelAnimationFrame(frame);
		sound?.stopTension();
		tirada = result;
		const pick = tiradaPick({ ...result, prizeTitle: tiradaUnit(result) });
		const reel = reelStrip(result.candidates, [pick], 0, result.candidateSha256);
		strip = reel.strip;
		if (!stage) return;
		if (reduced) {
			position = reel.target;
			land();
			return;
		}
		stage.phase = 'spinning';
		live = spinAnnouncement(pick);
		const plan: SpinPlan = planSpin({ length: reel.strip.length, target: reel.target, kind: 'winner' });
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
				land();
				return;
			}
			frame = requestAnimationFrame(step);
		};
		frame = requestAnimationFrame(step);
	}

	async function land() {
		if (!stage || !tirada) return;
		stage.phase = 'landed';
		live = pickAnnouncement(tiradaPick({ ...tirada, prizeTitle: tiradaUnit(tirada) }));
		sound?.stopTension();
		sound?.fanfare();
		if (!reduced) burst += 1;
		await tick();
		backButton?.focus();
	}

	async function closeStage() {
		cancelAnimationFrame(frame);
		sound?.stopTension();
		const drawn = stage && stage.phase === 'landed' && !stage.replay;
		stage = null;
		tirada = null;
		pool = null;
		drawError = null;
		if (drawn) await invalidateAll();
	}

	// ─── App prizes: one drand-backed tirada per prize (T9; S6, S8) ──────────
	type PrizePhase = 'confirm' | 'waiting' | 'stalled' | 'refused' | 'spinning' | 'landed';
	let prizeStage = $state<{ phase: PrizePhase; row: AppPrizeRow; drandRound: number | null; index: number } | null>(null);
	let prizeResult = $state<AppPrizeDrawResult | null>(null);
	let prizePicks = $state<AppDrawPick[]>([]);
	let prizeError = $state<string | null>(null);
	let prizeTimer: ReturnType<typeof setTimeout> | undefined;
	let peekTimer: ReturnType<typeof setTimeout> | undefined;
	let destroyed = false;
	let prizeBack: HTMLButtonElement | undefined = $state();
	const lastPick = $derived(prizeStage !== null && prizeStage.index === prizePicks.length - 1);
	const currentPick = $derived(prizeStage ? (prizePicks[prizeStage.index] ?? null) : null);
	const pickName = (pick: AppDrawPick) => room.winners.find((winner) => winner.prizeId === pick.prizeId && winner.slot === pick.slot && winner.entryNumber === pick.entryNumber)?.identity?.name ?? pick.maskedName;
	const pause = (ms: number) => new Promise<void>((resolve) => (prizeTimer = setTimeout(resolve, ms)));

	/** "Sortear <premio>": a confirmation first; a tirada already committed resumes at once with its round. */
	async function choosePrize(row: AppPrizeRow) {
		prizeError = null;
		prizeResult = null;
		prizePicks = [];
		strip = [];
		if (row.state === 'committed') {
			prizeStage = { phase: 'waiting', row, drandRound: row.drandRound, index: 0 };
			void drawPrize();
			return;
		}
		prizeStage = { phase: 'confirm', row, drandRound: null, index: 0 };
		await tick();
		document.getElementById('prize-draw-confirm')?.focus();
	}

	/**
	 * Asks the API for the prize's tirada until it is revealed: while the answer is 202 or lost the
	 * same POST goes again every 2 s, which resumes the committed round; after a minute "Reintentar"
	 * does the same. Never a new tirada: the API keeps the one committed.
	 */
	async function drawPrize() {
		if (!prizeStage) return;
		ensureSound();
		const prizeId = prizeStage.row.prizeId;
		prizeError = null;
		prizeStage.phase = 'waiting';
		live = waitingText(prizeStage.drandRound);
		if (prizeStage.drandRound === null) void peekRound(prizeId);
		const started = Date.now();
		for (;;) {
			const answer = await act<{ prizeDraw: AppPrizeDrawResult; status: number }>('sortearPremio', { prizeId });
			if (destroyed || prizeStage?.row.prizeId !== prizeId) return;
			if (answer.ok) {
				prizeStage.drandRound = answer.data.prizeDraw.drandRound;
				if (!strip.length && answer.data.prizeDraw.candidates.length) drift(answer.data.prizeDraw.candidates, answer.data.prizeDraw.candidateSha256);
			}
			const step = drawStep(answer.ok ? { status: answer.data.status } : answer.status === 0 ? null : answer, Date.now() - started);
			if (step === 'reveal' && answer.ok) {
				playPrize(answer.data.prizeDraw);
				return;
			}
			if (step === 'refused') {
				prizeStage.phase = 'refused';
				prizeError = answer.ok ? null : answer.message;
				live = prizeError ?? '';
				return;
			}
			if (step === 'stalled') {
				prizeStage.phase = 'stalled';
				live = 'drand todavía no publicó la ronda.';
				return;
			}
			live = waitingText(prizeStage.drandRound);
			await pause(DRAND_POLL_MS);
			if (destroyed || prizeStage?.row.prizeId !== prizeId) return;
		}
	}

	/**
	 * The API answers once the round is read, a few seconds after the click, but it stores the
	 * commitment at once: the room view names the committed round meanwhile, for the wait.
	 */
	async function peekRound(prizeId: string) {
		await new Promise<void>((resolve) => (peekTimer = setTimeout(resolve, 800)));
		if (destroyed || prizeStage?.row.prizeId !== prizeId || prizeStage.drandRound !== null) return;
		await invalidateAll();
		const round = prizeRows.find((row) => row.prizeId === prizeId)?.drandRound ?? null;
		if (prizeStage?.row.prizeId === prizeId && prizeStage.phase === 'waiting' && prizeStage.drandRound === null && round !== null) {
			prizeStage.drandRound = round;
			live = waitingText(round);
		}
	}

	/** The reveal: the table refreshes behind the stage while the reel stops once per unit. */
	function playPrize(result: AppPrizeDrawResult) {
		if (!prizeStage) return;
		prizeResult = result;
		prizePicks = prizeDrawPicks(result, prizeStage.row.quantity);
		void invalidateAll();
		if (prizePicks.length === 0) {
			prizeStage.phase = 'landed';
			return;
		}
		spinPrize(0);
	}

	function spinPrize(index: number) {
		if (!prizeStage || !prizeResult) return;
		cancelAnimationFrame(frame);
		sound?.stopTension();
		prizeStage.index = index;
		const pick = prizePicks[index]!;
		const reel = reelStrip(prizeResult.candidates, prizePicks, index, prizeResult.candidateSha256);
		strip = reel.strip;
		if (reduced) {
			position = reel.target;
			landPrize();
			return;
		}
		prizeStage.phase = 'spinning';
		live = spinAnnouncement(pick);
		// The first stop is the long one; each next unit of the prize is a short spin.
		const plan: SpinPlan = planSpin({ length: reel.strip.length, target: reel.target, kind: index === 0 ? 'winner' : 'alternate' });
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
				landPrize();
				return;
			}
			frame = requestAnimationFrame(step);
		};
		frame = requestAnimationFrame(step);
	}

	async function landPrize() {
		if (!prizeStage) return;
		prizeStage.phase = 'landed';
		const index = prizeStage.index;
		const pick = prizePicks[index];
		if (pick) live = pickAnnouncement({ ...pick, maskedName: pickName(pick) });
		sound?.stopTension();
		sound?.fanfare();
		if (!reduced) burst += 1;
		if (index < prizePicks.length - 1) {
			const prizeId = prizeStage.row.prizeId;
			await pause(reduced ? 700 : 2_200);
			if (!destroyed && prizeStage?.row.prizeId === prizeId) spinPrize(index + 1);
			return;
		}
		await tick();
		prizeBack?.focus();
	}

	async function closePrizeStage() {
		cancelAnimationFrame(frame);
		clearTimeout(prizeTimer);
		sound?.stopTension();
		prizeStage = null;
		prizeResult = null;
		prizePicks = [];
		prizeError = null;
		// Drawn, waiting or refused: the list shows the API's state again.
		await invalidateAll();
	}

	// A reload while a tirada waits for its round shows the wait and resumes it (same round).
	onMount(() => {
		const pending = prizeRows.find((row) => row.state === 'committed' && row.drawable);
		if (pending) void choosePrize(pending);
	});

	const confettiColors = ['#F5F7FB', '#14161B', 'var(--accent)'];
	let accent = $state('#F04438');
	onMount(() => {
		accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || accent;
	});
	const colors = $derived(confettiColors.map((color) => (color === 'var(--accent)' ? accent : color)));

	// ─── Coupon lookup (S7, `campanas/[id]/en-vivo`) ────────────────────────
	let coupon = $state('');
	let lookup = $state<CouponLookup | null>(null);
	let lookupError = $state<string | null>(null);
	let looking = $state(false);
	const found = $derived(lookup ? lookupView(lookup) : null);

	async function search(event?: SubmitEvent) {
		event?.preventDefault();
		const parsed = parseCouponNumber(coupon, campaign.entryDigits);
		if (!parsed.ok) {
			lookupError = couponParseMessage(parsed.reason, campaign.entryDigits);
			return;
		}
		looking = true;
		lookupError = null;
		const answer = await act<{ lookup: CouponLookup }>('buscar', { cupon: coupon });
		looking = false;
		if (answer.ok) {
			lookup = answer.data.lookup;
			coupon = '';
		} else lookupError = answer.message;
	}

	function onCoupon() {
		lookupError = null;
		if (autoSubmitReady(coupon, campaign.entryDigits) && !looking) void search();
	}

	// ─── Header facts ───────────────────────────────────────────────────────
	let copied = $state(false);
	async function copyHash() {
		if (!room.manifest) return;
		await navigator.clipboard.writeText(room.manifest.sha256);
		copied = true;
		setTimeout(() => (copied = false), 2000);
	}

	// ─── Broadcast mode ─────────────────────────────────────────────────────
	let root: HTMLElement | undefined = $state();
	let fullscreen = $state(false);
	onMount(() => {
		const onFullscreen = () => (fullscreen = Boolean(document.fullscreenElement));
		document.addEventListener('fullscreenchange', onFullscreen);
		return () => document.removeEventListener('fullscreenchange', onFullscreen);
	});

	async function setBroadcast(on: boolean) {
		// Full screen needs the click itself, before the address changes.
		if (on && !document.fullscreenElement) void root?.requestFullscreen?.().catch(() => undefined);
		if (!on && document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
		broadcast = on;
		const url = new URL(page.url.href);
		if (on) url.searchParams.set(BROADCAST_PARAM, '');
		else url.searchParams.delete(BROADCAST_PARAM);
		await goto(url, { replace: true, reset: false });
	}

	function toggleBroadcast(event: MouseEvent) {
		event.preventDefault();
		void setBroadcast(!broadcast);
	}

	const tiradas = $derived(room.appDraw.tiradas);
	const winnerName = $derived(tirada ? (room.winners.find((winner) => winner.prizeId === tirada!.prizeId && winner.slot === tirada!.slot && winner.entryNumber === tirada!.pick.entryNumber)?.identity?.name ?? tirada.pick.maskedName) : '');
	const broadcastHref = $derived(broadcast ? '?' : `?${BROADCAST_PARAM}`);
</script>

<svelte:head>
	<title>Sala de sorteo | {campaign.title}</title>
</svelte:head>

<div class="room" class:broadcast bind:this={root}>
	<header class="head">
		<div class="ident">
			{#if !broadcast}<p class="eyebrow">Sala de sorteo <span class="chip {status.tone}">{status.label}</span></p>{/if}
			<h1>{campaign.title}</h1>
			{#if campaign.subtitle}<p class="subtitle">{campaign.subtitle}</p>{/if}
		</div>
		<div class="controls">
			<button type="button" class="control" aria-pressed={!muted} onclick={toggleSound}><span class="sound-icon" class:off={muted} aria-hidden="true"></span>Sonido</button>
			<a class="control" href={broadcastHref} onclick={toggleBroadcast}>{broadcast ? 'Salir del modo transmisión' : 'Modo transmisión'}</a>
		</div>
	</header>

	<section class="prizes" aria-label="Premios">
		<ul>
			{#each room.prizes as prize (prize.id)}
				<li>
					{#if prize.imageUrl}<img src={prize.imageUrl} alt="" loading="lazy" />{/if}
					<span class="prize-title">{prize.title}</span>
					{#if prize.quantity > 1}<span class="muted">{unitsLabel(prize.quantity)}</span>{/if}
				</li>
			{/each}
		</ul>
	</section>

	<dl class="facts">
		<div><dt>Orden</dt><dd>{awardOrderLabel[campaign.awardOrder]}</dd></div>
		<div><dt>Cupones habilitados</dt><dd>{new Intl.NumberFormat('es-AR').format(room.coupons.eligible)}</dd></div>
		{#if room.manifest}
			<div>
				<dt>Huella del manifiesto</dt>
				<dd class="hash">
					<span title={broadcast ? undefined : room.manifest.sha256}>{onAirHash(room.manifest.sha256)}</span>
					{#if !broadcast}<button type="button" class="link" onclick={copyHash}>{copied ? 'Copiada' : 'Copiar'}</button>{/if}
				</dd>
			</div>
		{/if}
		<div><dt>Ronda</dt><dd>{campaign.round}</dd></div>
	</dl>

	<div class="floor" class:single={!hasAppPrizes && !hasQuiniela}>
		{#if hasAppPrizes || hasQuiniela}
		<div class="main">
		{#if hasAppPrizes}
			<AppPrizeList rows={prizeRows} busy={Boolean(stage || prizeStage)} {broadcast} reason={room.appPrizes?.reason ?? null} ondraw={choosePrize} />
		{/if}
		{#if hasQuiniela}
		<section class="quiniela" aria-labelledby="quiniela-title">
			<div class="section-head">
				<h2 id="quiniela-title">Números de la Quiniela</h2>
				{#if room.quinielaDraw && !broadcast}<p class="muted small">{room.quinielaDraw.source}, {dateTime(room.quinielaDraw.drawnAt, campaign.timezone)}</p>{/if}
			</div>
			{#if room.quinielaDraw}
				<ExtractGrid {rows} editable={false} />
			{:else if entryOpen}
				{#if !broadcast}<p class="muted small">Escribí cada número a medida que sale: con 4 cifras pasa al siguiente (o con Enter). Se compara al instante y podés corregirlo hasta confirmar.</p>{/if}
				{#key restored}
					<ExtractGrid {rows} editable oninput={onExtractInput} onkeydown={onExtractKey} />
				{/key}
				{#if liveError}<p class="notice error" role="alert">{liveError}</p>{/if}

				{#if !broadcast}
					<div class="details" oninput={onDetails}>
						<div class="field">
							<label for="source">Sorteo</label>
							<input id="source" name="source" bind:value={source} maxlength="200" autocomplete="off" />
						</div>
						<div class="field">
							<label for="drawDate">Fecha y hora oficial</label>
							{#key restored}
								<DateField id="drawDate" name="drawDate" timeName="drawTime" date={drawDate} time={drawTime} timeLabel="Hora oficial" describedby="drawDate-hint" />
							{/key}
							<p id="drawDate-hint" class="muted small">Hora de {campaign.timezone.replace(/_/g, ' ')}. Tiene que ser posterior a la publicación del manifiesto y no puede ser futura.</p>
						</div>
						<div class="field wide">
							<label for="evidenceUrl">Enlace al extracto oficial</label>
							<input id="evidenceUrl" name="evidenceUrl" type="url" inputmode="url" bind:value={evidenceUrl} placeholder="https://" autocomplete="off" aria-describedby="evidence-hint" />
							<p id="evidence-hint" class="muted small">El enlace https al extracto oficial publicado por la lotería: queda público en la transparencia.</p>
						</div>
					</div>
				{/if}

				{#if recordError}<p class="notice error" role="alert">{recordError}</p>{/if}
				{#if review}
					<div class="confirm" role="alertdialog" aria-labelledby="record-title" aria-describedby="record-text">
						<h3 id="record-title">¿Registrás los 20 números?</h3>
						<p id="record-text">
							{reviewWinners === 1 ? '1 premio queda con ganador' : `${reviewWinners} premios quedan con ganador`}{review.vacant.length ? ` y ${review.vacant.length === 1 ? '1 queda vacante' : `${review.vacant.length} quedan vacantes`}` : ''}. Quedan registrados y públicos: no se pueden cambiar después.
						</p>
						<div class="row">
							<button id="record-confirm" type="button" class="go" disabled={recording} onclick={record}>{recording ? 'Registrando…' : 'Registrar los 20 números'}</button>
							<button type="button" class="control" onclick={() => (review = null)}>Volver a corregir</button>
						</div>
					</div>
				{:else if complete}
					{#if broadcast && (!drawDate || !drawTime || !evidenceUrl)}
						<p class="muted small">Están los 20 números. Para confirmarlos, salí del modo transmisión y completá la fecha, la hora y el enlace del extracto.</p>
					{:else}
						<button type="button" class="go" disabled={recording} onclick={askReview}>{recording ? 'Revisando…' : 'Confirmar los 20 números'}</button>
					{/if}
				{:else if !broadcast}
					<p class="muted small">Faltan {EXTRACT_COUNT - prefix.length} {EXTRACT_COUNT - prefix.length === 1 ? 'número' : 'números'} para confirmar.</p>
				{/if}
			{:else}
				<p class="muted">
					{campaign.status === 'awarding' ? 'Falta el manifiesto publicado de esta ronda.' : 'La carga de la Quiniela se habilita con la campaña en adjudicación, después del cierre y de la publicación del manifiesto.'}
				</p>
			{/if}
		</section>
		{/if}
		</div>
		{/if}

		<div class="side">
			{#if hasUnitTable}
				<UnitTable rows={units} progress={tableProgress(units)} busy={Boolean(stage || prizeStage)} ondraw={chooseUnit} />
			{/if}
			{#if room.quinielaDraw && room.appDraw.reason && room.appDraw.units.length && !broadcast}
				<p class="muted small">{room.appDraw.reason}</p>
			{/if}

			{#if tiradas.length || prizeTiradas.length}
				<section class="tiradas" aria-labelledby="tiradas-title">
					<h2 id="tiradas-title">Registro de tiradas</h2>
					{#if prizeTiradas.length}
						<!-- T9: one tirada per app prize, with the drand round it is bound to. -->
						<ol aria-label="Tiradas con número público de drand">
							{#each prizeTiradas as row (row.key)}
								<li>
									<span class="when">{dateTime(row.committedAt, campaign.timezone).slice(-5)}</span>
									<span class="what">Tirada {row.sequence}: {row.prizeTitle} · {row.units}</span>
									<span class="proof">Ronda {row.drandRound} de drand{row.state === 'committed' ? ' · esperando el número' : ''}</span>
									<span class="proof">{row.candidates} · SHA-256 {row.hash}</span>
								</li>
							{/each}
						</ol>
					{/if}
					{#if tiradas.length}
					<ol>
						{#each tiradas as row (row.sequence)}
							<li>
								<span class="when">{dateTime(row.drawnAt, campaign.timezone).slice(-5)}</span>
								<span class="what">Tirada {row.sequence}: {tiradaUnit(row)}{row.attempt > 1 ? ` (intento ${row.attempt})` : ''}</span>
								<span class="pick">{row.pick.entryNumber} · {row.pick.maskedName}</span>
								<span class="proof">Entre {candidatesLabel(row.candidateCount)} · SHA-256 {onAirHash(row.candidateSha256)}</span>
								<button type="button" class="link" disabled={Boolean(stage || prizeStage)} onclick={() => replay(row.sequence)}>Ver la animación</button>
							</li>
						{/each}
					</ol>
					{/if}
				</section>
			{/if}

			<section class="lookup" aria-labelledby="lookup-title">
				<h2 id="lookup-title">Buscar un cupón</h2>
				<form onsubmit={search} novalidate>
					<label class="visually-hidden" for="cupon">Número de cupón</label>
					<div class="row">
						<input id="cupon" name="cupon" bind:value={coupon} oninput={onCoupon} inputmode="numeric" autocomplete="off" spellcheck="false" placeholder={'0'.repeat(campaign.entryDigits)} aria-invalid={lookupError ? 'true' : undefined} />
						<button class="control" disabled={looking}>Buscar</button>
					</div>
				</form>
				{#if lookupError}<p class="notice error" role="alert">{lookupError}</p>{/if}
				<div aria-live="polite">
					{#if found}
						<article class="result {found.tone}" aria-label="Resultado del cupón {found.coupon}">
							<p class="coupon">{found.coupon}</p>
							<p class="headline">{found.headline}</p>
							{#if found.prize}<p class="result-prize">{found.prize}</p>{/if}
							{#if found.identity}<p class="identity">{found.identity.name}{found.identity.place ? ` ${found.identity.place}` : ''}</p>{/if}
							{#if found.note}<p class="muted small">{found.note}</p>{/if}
						</article>
					{/if}
				</div>
			</section>
		</div>
	</div>

	{#if stage}
		<div class="stage" role="dialog" aria-modal="true" aria-labelledby="stage-title">
			<div class="stage-head">
				<p class="role">{stage.replay ? 'Tirada guardada' : 'Sorteo en la app'}</p>
				<h2 id="stage-title" class="stage-title">{stage.row.label}</h2>
			</div>
			<div class="reel-area">
				<AppDrawReel {strip} position={position} landed={stage.phase === 'landed'} />
				{#if stage.phase === 'landed' && tirada}
					<div class="winner">
						<p class="winner-role">Ganador</p>
						<p class="winner-number">{tirada.pick.entryNumber}</p>
						<p class="winner-name">{winnerName}</p>
						<p class="winner-prize">{stage.row.label}</p>
					</div>
				{/if}
			</div>
			<div class="after">
				{#if drawError}<p class="notice error" role="alert">{drawError}</p>{/if}
				{#if stage.phase === 'confirm'}
					{#if pool}
						<p>Participan {candidatesLabel(pool.candidateCount)} sin premio. La plataforma elige uno con un número aleatorio criptográfico y lo guarda antes de mostrarlo. No se puede deshacer.</p>
					{:else if !drawError}
						<p class="muted">Preparando los cupones en juego…</p>
					{/if}
					<div class="row">
						<button id="draw-confirm" type="button" class="go" disabled={!pool} onclick={drawUnit}>Confirmar y sortear</button>
						<button type="button" class="control" onclick={closeStage}>Cancelar</button>
					</div>
				{:else if stage.phase === 'drawing'}
					<p class="muted">Sorteando…</p>
				{:else if stage.phase === 'spinning'}
					<p class="muted">Pasan los {new Intl.NumberFormat('es-AR').format(strip.length)} cupones en juego.</p>
				{:else if tirada}
					<p class="muted small">Entre {candidatesLabel(tirada.candidateCount)} · SHA-256 {onAirHash(tirada.candidateSha256)}</p>
					<button type="button" class="go" bind:this={backButton} onclick={closeStage}>Volver a la tabla</button>
				{/if}
			</div>
		</div>
	{/if}

	{#if prizeStage}
		<!-- T9: one tirada per app prize; the reel stops once per unit, in drawing order. -->
		<div class="stage" role="dialog" aria-modal="true" aria-labelledby="prize-stage-title">
			<div class="stage-head">
				<p class="role">Sorteo en la app con número público (drand)</p>
				<h2 id="prize-stage-title" class="stage-title">{prizeStage.row.title}</h2>
			</div>
			<div class="reel-area">
				<AppDrawReel {strip} {position} landed={prizeStage.phase === 'landed'} />
				{#if prizeStage.phase === 'landed' && currentPick}
					{#key prizeStage.index}
						<div class="winner">
							<p class="winner-role">{prizePicks.length > 1 ? `Ganador ${prizeStage.index + 1} de ${prizePicks.length}` : 'Ganador'}</p>
							<p class="winner-number">{currentPick.entryNumber}</p>
							<p class="winner-name">{pickName(currentPick)}</p>
							<p class="winner-prize">{currentPick.prizeTitle}</p>
						</div>
					{/key}
				{/if}
			</div>
			<div class="after">
				{#if prizeError}<p class="notice error" role="alert">{prizeError}</p>{/if}
				{#if prizeStage.phase === 'confirm'}
					<p>{drawConfirmText(prizeStage.row, room.appPrizes?.candidateCount ?? null)}</p>
					<p class="muted small">Al confirmar quedan fijas la lista de cupones y la próxima ronda de drand, que todavía no salió. Los ganadores salen de ese número público y cualquiera puede recalcularlos. No se puede deshacer.</p>
					<div class="row">
						<button id="prize-draw-confirm" type="button" class="go" onclick={drawPrize}>Confirmar y sortear</button>
						<button type="button" class="control" onclick={closePrizeStage}>Cancelar</button>
					</div>
				{:else if prizeStage.phase === 'waiting'}
					<p class="waiting" role="status">{waitingText(prizeStage.drandRound)}</p>
				{:else if prizeStage.phase === 'stalled'}
					<p>drand todavía no publicó la ronda{prizeStage.drandRound ? ` ${prizeStage.drandRound}` : ''}. La tirada sigue comprometida con esa ronda: «Reintentar» la retoma, nunca hace otra.</p>
					<div class="row">
						<button type="button" class="go" onclick={drawPrize}>Reintentar</button>
						<button type="button" class="control" onclick={closePrizeStage}>Cerrar</button>
					</div>
				{:else if prizeStage.phase === 'refused'}
					<button type="button" class="control" onclick={closePrizeStage}>Volver a la lista</button>
				{:else if prizeStage.phase === 'spinning'}
					<p class="muted">{prizePicks.length > 1 ? `Ganador ${prizeStage.index + 1} de ${prizePicks.length}: pasan` : 'Pasan'} los {new Intl.NumberFormat('es-AR').format(strip.length)} cupones en juego.</p>
				{:else if prizeResult}
					{#if prizePicks.length > 1}
						<ol class="drawn" aria-label="Ganadores de {prizeStage.row.title}">
							{#each prizePicks.slice(0, prizeStage.index + 1) as pick (pick.slot)}
								<li><span class="muted">{pick.slot}.</span> {pick.entryNumber} · {pickName(pick)}</li>
							{/each}
						</ol>
					{/if}
					<p class="muted small">Ronda {prizeResult.drandRound} de drand · Entre {candidatesLabel(prizeResult.candidateCount)} · SHA-256 {onAirHash(prizeResult.candidateSha256)}</p>
					{#if lastPick || prizePicks.length === 0}
						<button type="button" class="go" bind:this={prizeBack} onclick={closePrizeStage}>Volver a la lista</button>
					{/if}
				{/if}
			</div>
		</div>
	{/if}

	<p class="visually-hidden" aria-live="polite" aria-atomic="true">{live}</p>
	<Confetti {burst} pieces={200} {colors} />
</div>

<style>
	.room {
		--room-cell: var(--surface);
		--room-line: var(--border);
		--room-muted: var(--muted);
		display: grid;
		gap: 1.25rem;
	}

	/*
	 * Broadcast mode (S3): the dark stage of the in-app draw, whatever the panel theme, over the whole
	 * window. Only the campaign, the prizes, the positions, the table and the reel; no account, menus,
	 * links or system data.
	 */
	.room.broadcast {
		--stage-bg: #121418;
		--stage-ink: #1c1f26;
		--stage-text: #f5f7fb;
		--stage-muted: #8d96a6;
		--room-cell: var(--stage-ink);
		--room-line: color-mix(in srgb, var(--stage-text) 16%, transparent);
		--room-muted: var(--stage-muted);
		position: fixed;
		inset: 0;
		z-index: 50;
		overflow: auto;
		gap: clamp(0.4rem, 1.2vh, 1rem);
		align-content: start;
		padding: clamp(0.6rem, 1.5vh, 1.25rem) clamp(0.75rem, 2vw, 2rem);
		background:
			radial-gradient(ellipse at 50% 40%, color-mix(in srgb, var(--accent) 10%, transparent), transparent 60%),
			var(--stage-bg);
		color: var(--stage-text);
	}

	.head {
		display: flex;
		flex-wrap: wrap;
		align-items: start;
		justify-content: space-between;
		gap: 0.75rem 1.5rem;
	}

	.ident {
		display: grid;
		gap: 0.3rem;
	}

	.eyebrow {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		font-size: 0.75rem;
		font-weight: 700;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--room-muted);
	}

	h1 {
		font-size: var(--step-4);
	}

	.broadcast h1 {
		font-size: clamp(1.6rem, 5vh, 3.2rem);
	}

	.subtitle {
		font-weight: 600;
		color: var(--room-muted);
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
		min-height: 2.5rem;
		padding: 0.45rem 0.95rem;
		border: 1px solid var(--room-line);
		border-radius: 999px;
		background: transparent;
		color: inherit;
		font: 600 var(--step--1) / 1.2 var(--font-body);
		text-decoration: none;
		cursor: pointer;
	}

	.control:hover {
		border-color: currentColor;
	}

	/* On air the controls stay, discreet. */
	.broadcast .controls .control {
		opacity: 0.55;
	}

	.broadcast .controls .control:hover,
	.broadcast .controls .control:focus-visible {
		opacity: 1;
	}

	.sound-icon {
		width: 0.8rem;
		height: 0.8rem;
		border-radius: 50%;
		background: var(--accent);
	}

	.sound-icon.off {
		background: transparent;
		box-shadow: inset 0 0 0 2px var(--room-muted);
	}

	.prizes ul {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem 1rem;
	}

	.prizes li {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.35rem 0.75rem 0.35rem 0.35rem;
		border-radius: 999px;
		background: var(--room-cell);
	}

	.prizes img {
		width: 2.5rem;
		height: 2.5rem;
		border-radius: 50%;
		object-fit: cover;
	}

	.prize-title {
		font: 800 var(--step-1) / 1 var(--font-display);
	}

	.facts {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem 2rem;
		margin: 0;
	}

	.facts div {
		display: grid;
		gap: 0.1rem;
	}

	dt {
		font-size: 0.75rem;
		font-weight: 700;
		color: var(--room-muted);
	}

	dd {
		margin: 0;
		font-weight: 700;
	}

	.hash {
		display: flex;
		gap: 0.75rem;
		font-variant-numeric: tabular-nums;
	}

	.link {
		padding: 0;
		border: 0;
		background: none;
		color: var(--accent);
		font: inherit;
		font-size: var(--step--1);
		text-decoration: underline;
		cursor: pointer;
	}

	.floor {
		display: grid;
		grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr);
		gap: clamp(1rem, 2.5vw, 2.5rem);
		align-items: start;
	}

	.floor.single {
		grid-template-columns: minmax(0, 1fr);
	}

	.main,
	.quiniela,
	.side,
	.tiradas,
	.lookup {
		display: grid;
		gap: 0.75rem;
		align-content: start;
		min-width: 0;
	}

	.section-head {
		display: grid;
		gap: 0.25rem;
	}

	h2 {
		font-size: var(--step-2);
	}

	.details {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 0.75rem 1rem;
		padding-top: 0.5rem;
		border-top: 1px solid var(--room-line);
	}

	.field {
		display: grid;
		gap: 0.3rem;
		align-content: start;
	}

	.field.wide {
		grid-column: 1 / -1;
	}

	.go {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		justify-self: start;
		min-height: 3rem;
		padding: 0.7rem 2rem;
		border: 0;
		border-radius: 999px;
		background: var(--accent);
		color: var(--accent-text, #fff);
		font: 800 var(--step-1) / 1 var(--font-display);
		cursor: pointer;
	}

	.go[disabled] {
		opacity: 0.6;
		cursor: progress;
	}

	.confirm {
		display: grid;
		gap: 0.75rem;
		padding: 1rem 1.25rem;
		border-left: 4px solid var(--accent);
		background: var(--room-cell);
	}

	h3 {
		font-size: var(--step-1);
	}

	.waiting {
		font: 800 clamp(1.1rem, 3.4vh, 2rem) / 1.2 var(--font-display);
		color: var(--accent);
	}

	.drawn {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-wrap: wrap;
		justify-content: center;
		gap: 0.3rem 1.5rem;
		font: 800 var(--step-1) / 1.1 var(--font-display);
		font-variant-numeric: tabular-nums;
	}

	.tiradas ol {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 0.4rem;
	}

	.tiradas li {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr);
		gap: 0.1rem 0.75rem;
		padding: 0.5rem 0.75rem;
		background: var(--room-cell);
		border-radius: var(--radius-sm);
		font-size: var(--step--1);
	}

	.when {
		grid-row: span 3;
		font-weight: 800;
		font-variant-numeric: tabular-nums;
	}

	.what {
		font-weight: 700;
	}

	.pick {
		font: 800 var(--step-1) / 1.1 var(--font-display);
	}

	.proof {
		color: var(--room-muted);
		font-variant-numeric: tabular-nums;
	}

	.tiradas .link {
		grid-column: 2;
		justify-self: start;
	}

	.lookup input {
		flex: 1;
		min-width: 0;
		font: 800 var(--step-1) / 1 var(--font-display);
		font-variant-numeric: tabular-nums;
		letter-spacing: 0.06em;
	}

	.broadcast .lookup input {
		background: var(--stage-ink);
		color: var(--stage-text);
		border-color: var(--room-line);
	}

	.result {
		display: grid;
		gap: 0.25rem;
		padding: 0.85rem 1rem;
		border-left: 4px solid var(--room-line);
		background: var(--room-cell);
	}

	.result.win {
		border-left-color: var(--accent);
	}

	.result.bad {
		border-left-color: var(--danger, #f04438);
	}

	.coupon {
		font: 800 var(--step-3) / 1 var(--font-display);
		font-variant-numeric: tabular-nums;
	}

	.headline,
	.identity {
		font-weight: 800;
	}

	.result-prize {
		color: var(--accent);
		font-weight: 700;
	}

	.notice {
		padding: 0.6rem 0.9rem;
	}

	.muted {
		color: var(--room-muted);
	}

	/* The reel of a tirada: the dark stage over everything, in the panel and on air. */
	.stage {
		--stage-bg: #121418;
		--stage-ink: #1c1f26;
		--stage-text: #f5f7fb;
		--stage-muted: #8d96a6;
		position: fixed;
		inset: 0;
		z-index: 60;
		display: grid;
		grid-template-rows: auto minmax(0, 1fr) auto;
		padding: clamp(0.75rem, 2vh, 1.5rem) clamp(1rem, 2vw, 2.5rem);
		background:
			radial-gradient(ellipse at 50% 55%, color-mix(in srgb, var(--accent) 10%, transparent), transparent 60%),
			var(--stage-bg);
		color: var(--stage-text);
		text-align: center;
		overflow: hidden;
	}

	.stage .muted {
		color: var(--stage-muted);
	}

	.stage .control {
		border-color: color-mix(in srgb, var(--stage-text) 28%, transparent);
		color: var(--stage-text);
	}

	.stage-head {
		display: grid;
		gap: 0.25rem;
	}

	.role {
		font-weight: 700;
		color: var(--accent);
		font-size: var(--step-1);
	}

	.stage-title {
		font-size: clamp(1.6rem, min(6vh, 7vw), 4.2rem);
	}

	.reel-area {
		position: relative;
		min-height: 0;
		display: grid;
		grid-template: minmax(0, 1fr) / minmax(0, 1fr);
	}

	.reel-area > :global(*) {
		grid-area: 1 / 1;
	}

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

	@keyframes arrive {
		from {
			opacity: 0;
			scale: 0.55;
		}
	}

	.after {
		position: relative;
		z-index: 2;
		display: grid;
		justify-items: center;
		gap: 0.6rem;
		padding-block: 0.75rem;
		min-height: 5rem;
		align-content: center;
	}

	.after .row {
		justify-content: center;
	}

	.after .go {
		justify-self: center;
	}

	@media (max-width: 860px) {
		.floor {
			grid-template-columns: minmax(0, 1fr);
		}

		.details {
			grid-template-columns: minmax(0, 1fr);
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
