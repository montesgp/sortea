<script lang="ts">
	import { couponParseMessage, parseCouponNumber } from '@sortea/domain';
	import { onMount, tick } from 'svelte';
	import { enhance } from '$app/forms';
	import { goto, replaceState } from '$app/navigation';
	import { page } from '$app/state';
	import { autoSubmitReady, HISTORY_LIMIT, historyItem, lookupView, parseHistory, type CouponLookup, type HistoryItem } from '#lib/coupon-lookup.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const campaign = $derived(data.context);
	const digits = $derived(campaign.entryDigits);

	// Plain form posts (no JavaScript) bring the result and the list back in `form`; with JavaScript the page overrides them.
	let current = $derived<CouponLookup | null>(form && 'result' in form ? (form.result ?? null) : null);
	let history = $derived<HistoryItem[]>(form?.history ?? []);
	let error = $derived<string | null>(form && 'message' in form ? (form.message ?? null) : null);
	let typed = $derived(form && 'coupon' in form ? (form.coupon ?? '') : '');
	let presentation = $derived(data.presentation);
	let pending = $state(false);
	let input: HTMLInputElement | undefined = $state();
	let searchForm: HTMLFormElement | undefined = $state();

	const view = $derived(current ? lookupView(current) : null);
	// The list holds coupons and outcomes only, never names, so it can live in this tab's storage.
	const storageKey = $derived(`sortea:en-vivo:${campaign.id}`);
	const action = $derived(presentation ? '?presentacion&/buscar' : '?/buscar');

	onMount(() => {
		if (history.length === 0) history = parseHistory(sessionStorage.getItem(storageKey) ?? '');
		input?.focus();
	});

	function remember(next: HistoryItem[]) {
		history = next.slice(-HISTORY_LIMIT);
		sessionStorage.setItem(storageKey, JSON.stringify(history));
	}

	async function ready() {
		await tick();
		input?.focus();
		input?.select();
	}

	function onInput() {
		error = null;
		if (autoSubmitReady(typed, digits) && !pending) searchForm?.requestSubmit();
	}

	function clear(event: SubmitEvent) {
		event.preventDefault();
		remember([]);
		current = null;
		error = null;
		typed = '';
		void ready();
	}

	function setPresentation(on: boolean) {
		presentation = on;
		const url = new URL(page.url.href);
		if (on) url.searchParams.set('presentacion', '');
		else url.searchParams.delete('presentacion');
		replaceState(url, {});
		void ready();
	}

	function togglePresentation(event: MouseEvent) {
		event.preventDefault();
		setPresentation(!presentation);
	}

	function onKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape' && presentation) setPresentation(false);
	}
</script>

<svelte:head>
	<title>Buscador en vivo | {campaign.title}</title>
</svelte:head>

<svelte:window onkeydown={onKeydown} />

<div class="live" class:presentation>
	<header class="head">
		{#if !presentation}<a class="small" href="/admin/campanas/{campaign.id}">Volver a {campaign.title}</a>{/if}
		<div class="title">
			<div>
				<h1>Buscador en vivo</h1>
				<p class="muted">{campaign.title}{campaign.round > 1 ? `, ronda ${campaign.round}` : ''}</p>
			</div>
			<a class="button small secondary" href={presentation ? '?' : '?presentacion'} onclick={togglePresentation}>
				{presentation ? 'Salir del modo presentación' : 'Modo presentación'}
			</a>
		</div>
	</header>

	<div class="stage">
		<section class="search" aria-label="Buscar cupón">
			<form
				bind:this={searchForm}
				method="POST"
				{action}
				novalidate
				use:enhance={({ formData, cancel }) => {
					const parsed = parseCouponNumber(String(formData.get('cupon') ?? ''), digits);
					if (!parsed.ok) {
						error = couponParseMessage(parsed.reason, digits);
						cancel();
						void ready();
						return;
					}
					// The page keeps the list itself; the server only needs the coupon.
					formData.delete('history');
					pending = true;
					error = null;
					return async ({ result }) => {
						pending = false;
						if (result.type === 'success' && result.data?.result) {
							current = result.data.result as CouponLookup;
							remember([...history, historyItem(current)]);
							typed = '';
						} else if (result.type === 'failure') {
							error = String(result.data?.message ?? 'No se pudo buscar el cupón');
						} else if (result.type === 'redirect') {
							await goto(result.location);
						} else {
							error = 'No se pudo buscar el cupón. Probá de nuevo';
						}
						await ready();
					};
				}}
			>
				<label for="cupon">Número de cupón</label>
				<div class="row">
					<input
						bind:this={input}
						bind:value={typed}
						oninput={onInput}
						id="cupon"
						name="cupon"
						inputmode="numeric"
						autocomplete="off"
						spellcheck="false"
						placeholder={'0'.repeat(digits)}
						aria-describedby="cupon-hint{error ? ' cupon-error' : ''}"
						aria-invalid={error ? 'true' : undefined}
					/>
					<button class="button" disabled={pending}>Buscar</button>
				</div>
				<input type="hidden" name="history" value={JSON.stringify(history)} />
				<p id="cupon-hint" class="muted small">Escribí los {digits} dígitos: busca solo al completarlos, o con Enter.</p>
				{#if error}<p id="cupon-error" class="notice error" role="alert">{error}</p>{/if}
			</form>

			<div class="result-area" aria-live="polite" aria-busy={pending}>
				{#if view}
					<article class="result {view.tone}" aria-label="Resultado del cupón {view.coupon}">
						<p class="coupon">{view.coupon}</p>
						<h2 class="headline">{view.headline}</h2>
						{#if view.prize}<p class="prize">{view.prize}</p>{/if}
						{#if view.identity}
							<div class="identity">
								<p class="name">{view.identity.name}</p>
								<p class="facts">
									{#if view.identity.place}<span>{view.identity.place}</span>{/if}
									<span>{view.identity.chances}</span>
								</p>
							</div>
						{/if}
						{#if view.note}<p class="note">{view.note}</p>{/if}
					</article>
				{:else}
					<p class="empty muted">Escribí el número de cada extracto a medida que sale.</p>
				{/if}
			</div>
		</section>

		<section class="history" aria-labelledby="history-title">
			<div class="history-head">
				<h2 id="history-title">Cupones buscados</h2>
				{#if history.length > 0}
					<form method="GET" onsubmit={clear}>
						{#if presentation}<input type="hidden" name="presentacion" value="" />{/if}
						<button class="button small quiet">Limpiar lista</button>
					</form>
				{/if}
			</div>
			{#if history.length === 0}
				<p class="muted small">Todavía no buscaste ningún cupón.</p>
			{:else}
				<ol class="list">
					{#each history as item, index (index)}
						<li class={item.kind}>
							<span class="position">{index + 1}.º</span>
							<span class="number">{item.coupon}</span>
							<span class="summary">{item.summary}</span>
						</li>
					{/each}
				</ol>
			{/if}
		</section>
	</div>
</div>

<style>
	.live {
		display: grid;
		gap: 1.5rem;
	}

	/* Covers the admin chrome so the capture shows only the lookup. */
	.live.presentation {
		position: fixed;
		inset: 0;
		z-index: 50;
		overflow: auto;
		padding: clamp(1rem, 0.5rem + 2vw, 2.5rem);
		background: var(--bg);
	}

	.head {
		display: grid;
		gap: 0.75rem;
	}

	.title {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
	}

	.stage {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(16rem, 22rem);
		gap: 1.5rem;
		align-items: start;
	}

	.search {
		display: grid;
		gap: 1.5rem;
	}

	label {
		display: block;
		margin-bottom: 0.5rem;
		font-weight: 700;
		font-size: var(--step-1);
	}

	.row {
		display: flex;
		gap: 0.75rem;
		align-items: stretch;
	}

	#cupon {
		flex: 1;
		min-width: 0;
		padding: 0.25rem 1rem;
		border: 2px solid var(--border);
		border-radius: var(--radius-sm);
		background: var(--surface);
		color: var(--text);
		font: 800 var(--step-5) / 1.1 var(--font-display);
		font-variant-numeric: tabular-nums;
		letter-spacing: 0.08em;
	}

	#cupon:focus-visible {
		outline: none;
		border-color: var(--accent);
		box-shadow: var(--focus);
	}

	#cupon[aria-invalid='true'] {
		border-color: var(--danger);
	}

	.row .button {
		font-size: var(--step-1);
		padding-inline: 1.5rem;
	}

	.result {
		display: grid;
		gap: 0.75rem;
		padding: clamp(1.25rem, 1rem + 2vw, 2.5rem);
		border: 2px solid var(--border);
		border-left-width: 12px;
		border-radius: var(--radius);
		background: var(--surface);
	}

	.result.win {
		border-color: var(--success);
	}

	.result.ok {
		border-color: var(--accent);
	}

	.result.bad {
		border-color: var(--danger);
	}

	.coupon {
		font: 800 var(--step-5) / 1 var(--font-display);
		font-variant-numeric: tabular-nums;
	}

	.headline {
		font: 800 var(--step-4) / 1.05 var(--font-display);
		text-transform: uppercase;
	}

	.result.win .headline {
		color: var(--success);
	}

	.result.bad .headline {
		color: var(--danger);
	}

	.prize {
		font-size: var(--step-3);
		font-weight: 700;
	}

	.identity {
		display: grid;
		gap: 0.35rem;
		padding-top: 0.75rem;
		border-top: 1px solid var(--border);
	}

	.name {
		font: 800 var(--step-4) / 1.05 var(--font-display);
		overflow-wrap: anywhere;
	}

	.facts {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem 1.5rem;
		font-size: var(--step-2);
		font-weight: 600;
	}

	.note {
		font-size: var(--step-2);
		font-weight: 600;
	}

	.empty {
		font-size: var(--step-1);
	}

	.history {
		display: grid;
		gap: 0.75rem;
		padding: 1rem;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--surface);
	}

	.history-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
	}

	.history h2 {
		font-size: var(--step-1);
	}

	.list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 0.35rem;
	}

	.list li {
		display: grid;
		grid-template-columns: 2.5rem auto minmax(0, 1fr);
		gap: 0.75rem;
		align-items: baseline;
		padding: 0.4rem 0.6rem;
		border-left: 4px solid var(--border);
		border-radius: var(--radius-sm);
		background: var(--surface-2);
	}

	.list li.winner,
	.list li.alternate {
		border-left-color: var(--success);
	}

	.list li.plays,
	.list li.sold {
		border-left-color: var(--accent);
	}

	.list li.void {
		border-left-color: var(--danger);
	}

	.position {
		color: var(--muted);
		font-size: var(--step--1);
	}

	.number {
		font: 800 var(--step-1) / 1 var(--font-display);
		font-variant-numeric: tabular-nums;
	}

	.summary {
		font-weight: 600;
		overflow-wrap: anywhere;
	}

	@media (max-width: 960px) {
		.stage {
			grid-template-columns: 1fr;
		}
	}
</style>
