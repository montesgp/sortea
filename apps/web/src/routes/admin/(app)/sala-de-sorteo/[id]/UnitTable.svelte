<script lang="ts">
	import { unitStateLabel, type UnitRow } from '#lib/draw-room.js';

	/**
	 * The winners table of the draw room (odd/tasks/draw-room.md T5, S4): every
	 * prize unit in award order with whoever holds it, live matches included, and
	 * "Sortear esta posición" on the units the API says can be drawn in the app.
	 * Names are the consented public name or the masked one, as the API sends them.
	 */
	let {
		rows,
		progress,
		busy = false,
		ondraw
	}: { rows: readonly UnitRow[]; progress: string; busy?: boolean; ondraw?: (row: UnitRow) => void } = $props();
</script>

<section class="table" aria-labelledby="winners-title">
	<div class="head">
		<h2 id="winners-title">Ganadores</h2>
		<p class="progress">{progress}</p>
	</div>
	<ol>
		{#each rows as row, index (row.key)}
			<li class={row.state} aria-label="{index + 1}.ª posición: {row.label}">
				<span class="place">{index + 1}.ª</span>
				<span class="prize">{row.label}</span>
				{#if row.holder}
					<span class="coupon">{row.holder.entryNumber}</span>
					<span class="name">{row.holder.name}</span>
					{#if row.holder.note}<span class="note">{row.holder.note}</span>{/if}
				{:else}
					<span class="state">{unitStateLabel[row.state]}</span>
				{/if}
				{#if row.drawable && ondraw}
					<button type="button" class="draw" disabled={busy} onclick={() => ondraw(row)}>Sortear esta posición</button>
				{/if}
			</li>
		{/each}
	</ol>
</section>

<style>
	.table {
		display: grid;
		gap: 0.6rem;
		align-content: start;
		min-height: 0;
	}

	.head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 1rem;
	}

	h2 {
		font-size: var(--step-2);
	}

	.progress {
		font: 800 var(--step-1) / 1 var(--font-display);
		font-variant-numeric: tabular-nums;
		color: var(--accent);
	}

	ol {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 0.4rem;
		overflow: auto;
		min-height: 0;
	}

	li {
		display: grid;
		grid-template-columns: 2.5rem minmax(0, 1fr) auto;
		align-items: center;
		gap: 0.1rem 0.75rem;
		padding: 0.55rem 0.75rem;
		border-left: 4px solid var(--room-line, var(--border));
		background: var(--room-cell, var(--surface));
		border-radius: var(--radius-sm);
	}

	.place {
		grid-row: span 2;
		font: 800 var(--step-1) / 1 var(--font-display);
		color: var(--room-muted, var(--muted));
	}

	.prize {
		font-weight: 700;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.coupon {
		font: 800 var(--step-2) / 1 var(--font-display);
		font-variant-numeric: tabular-nums;
		letter-spacing: 0.04em;
		text-align: end;
	}

	.name {
		font-weight: 700;
	}

	.note,
	.state {
		font-size: var(--step--1);
		font-weight: 600;
		color: var(--room-muted, var(--muted));
		text-align: end;
	}

	.state {
		grid-column: 2 / -1;
		text-align: start;
	}

	.won,
	.live {
		border-left-color: var(--accent);
	}

	.live .coupon {
		color: var(--accent);
	}

	.vacant .state,
	.exhausted .state {
		color: var(--warning);
		font-weight: 800;
	}

	.draw {
		grid-column: 2 / -1;
		justify-self: start;
		min-height: 2.5rem;
		padding: 0.45rem 1rem;
		border: 0;
		border-radius: 999px;
		background: var(--accent);
		color: var(--accent-text, #fff);
		font: 800 var(--step-0) / 1 var(--font-body);
		cursor: pointer;
	}

	.draw[disabled] {
		opacity: 0.6;
		cursor: progress;
	}
</style>
