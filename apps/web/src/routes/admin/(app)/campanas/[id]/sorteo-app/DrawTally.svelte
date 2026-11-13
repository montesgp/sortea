<script lang="ts">
	import { pickRole, rowLabel, tallyProgress, tallyRowState, type AppDrawPick } from '#lib/app-draw.js';

	/**
	 * The side table of the presentation screen (odd/tasks/owner-feedback-2026-11-12.md S3;
	 * ADR 0024 §5): every pick of the run in draw order, filled in as each one lands.
	 * Not a live region: the page announces each result once.
	 */
	let {
		picks,
		index,
		landed,
		prizeLabel
	}: { picks: readonly AppDrawPick[]; index: number; landed: boolean; prizeLabel: (pick: AppDrawPick) => string } = $props();

	let list: HTMLOListElement | undefined = $state();

	// Long runs scroll inside the panel: keep the pick on the reel in view.
	$effect(() => {
		const row = list?.children[index];
		if (!row) return;
		const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
		row.scrollIntoView({ block: 'nearest', behavior: reduced ? 'auto' : 'smooth' });
	});
</script>

<aside class="tally" aria-labelledby="tally-title">
	<div class="tally-head">
		<h2 id="tally-title">Ganadores</h2>
		<p class="tally-progress">{tallyProgress(index, picks.length, landed)}</p>
	</div>
	<ol bind:this={list}>
		{#each picks as drawn, row (row)}
			{@const state = tallyRowState(row, index, landed)}
			<li class={state} class:winner-row={drawn.role === 'winner'} class:fresh={row === index && landed} aria-current={state === 'current' ? 'step' : undefined}>
				<span class="tally-role">{pickRole(drawn)}</span>
				<span class="tally-prize">{prizeLabel(drawn)}</span>
				{#if state === 'done'}
					<span class="tally-coupon">{rowLabel(drawn)}</span>
				{:else if state === 'current'}
					<span class="tally-wait">Sorteando…</span>
				{:else}
					<span class="tally-wait">Por sortear</span>
				{/if}
			</li>
		{/each}
	</ol>
</aside>

<style>
	/* On the dark stage of the live stream: sized from the viewport height so 720p stays readable. */
	.tally {
		position: relative;
		z-index: 2;
		min-height: 0;
		display: grid;
		grid-template-rows: auto minmax(0, 1fr);
		gap: 0.6rem;
		padding: clamp(0.75rem, 2vh, 1.25rem);
		background: var(--stage-ink);
		border-top: 0.3rem solid var(--accent);
		text-align: start;
	}

	.tally-head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 1rem;
	}

	.tally-head h2 {
		font-size: clamp(1.2rem, 3.6vh, 2rem);
	}

	.tally-progress {
		font: 800 clamp(1.1rem, 3.2vh, 1.8rem) / 1 var(--font-display);
		font-variant-numeric: tabular-nums;
		color: var(--accent);
		white-space: nowrap;
	}

	ol {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		align-content: start;
		gap: 0.35rem;
		overflow: auto;
		min-height: 0;
	}

	li {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr);
		gap: 0.1rem 0.75rem;
		padding: clamp(0.35rem, 1.1vh, 0.7rem) 0.75rem;
		border-left: 0.3rem solid color-mix(in srgb, var(--stage-text) 18%, transparent);
		font-size: clamp(0.85rem, 2.4vh, 1.25rem);
	}

	.tally-role {
		font-weight: 800;
		color: var(--stage-muted);
	}

	.tally-prize {
		color: var(--stage-muted);
		font-weight: 600;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.tally-coupon,
	.tally-wait {
		grid-column: 1 / -1;
	}

	.tally-coupon {
		font: 800 clamp(1.1rem, 3.6vh, 2rem) / 1.1 var(--font-display);
		font-variant-numeric: tabular-nums;
		color: var(--stage-text);
	}

	.tally-wait {
		font-weight: 600;
		color: color-mix(in srgb, var(--stage-muted) 70%, transparent);
	}

	/* Winners carry the accent; alternates stay neutral. */
	.winner-row {
		border-left-color: var(--accent);
	}

	.winner-row .tally-role {
		color: var(--accent);
	}

	.current {
		background: color-mix(in srgb, var(--accent) 16%, transparent);
		border-left-color: var(--stage-text);
	}

	.current .tally-wait {
		color: var(--stage-text);
	}

	.pending {
		opacity: 0.65;
	}

	.fresh {
		animation: fill 0.9s var(--ease-out) both;
	}

	@keyframes fill {
		from {
			background: color-mix(in srgb, var(--accent) 55%, transparent);
			transform: scale(1.04);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.fresh {
			animation: none;
		}
	}
</style>
