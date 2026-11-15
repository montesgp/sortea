<script lang="ts">
	import { waitingText, type AppPrizeRow } from '#lib/draw-room.js';

	/**
	 * The `app` prizes of the draw room (odd/tasks/draw-room.md T9; S6, S8; ADR 0026):
	 * each prize in award order with its state and its winners, and one "Sortear"
	 * per prize. Only the next prize is the highlighted action; the others the API
	 * allows stay available, secondary. Names are the consented public name or the
	 * masked one, as the API sends them.
	 */
	let {
		rows,
		busy = false,
		broadcast = false,
		reason = null,
		ondraw
	}: { rows: readonly AppPrizeRow[]; busy?: boolean; broadcast?: boolean; reason?: string | null; ondraw?: (row: AppPrizeRow) => void } = $props();
</script>

<section class="app-prizes" aria-labelledby="app-prizes-title">
	<div class="head">
		<h2 id="app-prizes-title">Premios</h2>
		<p class="progress">{rows.filter((row) => row.state === 'drawn').length} de {rows.length} sorteados</p>
	</div>
	{#if reason && !broadcast && rows.every((row) => !row.drawable)}<p class="muted small">{reason}</p>{/if}
	<ol>
		{#each rows as row (row.prizeId)}
			<li class={row.state} class:next={row.primary} aria-label="Premio: {row.title}">
				{#if row.imageUrl}<img src={row.imageUrl} alt="" loading="lazy" />{:else}<span class="thumb" aria-hidden="true"></span>{/if}
				<div class="body">
					<p class="title">{row.title} <span class="units">{row.unitsLabel}</span></p>
					<p class="state">{row.stateLabel}</p>
					{#if row.state === 'committed'}<p class="waiting">{waitingText(row.drandRound)}</p>{/if}
					{#if row.winners.length}
						<ul class="winners" aria-label="Ganadores de {row.title}">
							{#each row.winners as winner (winner.slot)}
								<li>
									{#if row.quantity > 1}<span class="slot">{winner.slot}.</span>{/if}
									<span class="coupon">{winner.entryNumber}</span>
									<span class="name">{winner.name}</span>
								</li>
							{/each}
						</ul>
					{/if}
					{#if row.reason && row.state !== 'drawn' && !broadcast}<p class="muted small">{row.reason}</p>{/if}
				</div>
				{#if row.drawable && ondraw}
					<button type="button" class="draw" class:primary={row.primary} disabled={busy} onclick={() => ondraw(row)}>{row.drawLabel}</button>
				{/if}
			</li>
		{/each}
	</ol>
</section>

<style>
	.app-prizes {
		display: grid;
		gap: 1rem;
		align-content: start;
		min-width: 0;
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
		gap: 0.85rem;
	}

	/* Owner feedback 2026-11-14 S2: each prize with room around it, readable from a distance. */
	ol > li {
		--thumb: 4.5rem;
		display: grid;
		grid-template-columns: var(--thumb) minmax(0, 1fr) auto;
		align-items: center;
		gap: 0.75rem 1.5rem;
		padding: 1.1rem 1.4rem;
		border-left: 4px solid var(--room-line, var(--border));
		background: var(--room-cell, var(--surface));
		border-radius: var(--radius-sm);
	}

	ol > li.next,
	ol > li.committed {
		border-left-color: var(--accent);
	}

	:global(.broadcast) ol > li {
		--thumb: clamp(3.5rem, 8vh, 6.5rem);
		padding: clamp(0.75rem, 1.8vh, 1.6rem) clamp(1rem, 2vw, 2rem);
	}

	img,
	.thumb {
		width: var(--thumb);
		height: var(--thumb);
		border-radius: var(--radius-sm);
		object-fit: cover;
		background: var(--room-line, var(--border));
	}

	.body {
		display: grid;
		gap: 0.4rem;
		min-width: 0;
	}

	.title {
		font: 800 var(--step-2) / 1.1 var(--font-display);
	}

	:global(.broadcast) .title {
		font-size: clamp(1.3rem, 3.4vh, 2.5rem);
	}

	.units {
		font: 600 var(--step-0) / 1 var(--font-body);
		color: var(--room-muted, var(--muted));
	}

	.state {
		font-size: var(--step-0);
		font-weight: 700;
		color: var(--room-muted, var(--muted));
	}

	:global(.broadcast) .state,
	:global(.broadcast) .units {
		font-size: clamp(0.95rem, 2.2vh, 1.35rem);
	}

	:global(.broadcast) .body {
		gap: clamp(0.2rem, 0.6vh, 0.5rem);
	}

	.drawn .state {
		color: var(--accent);
	}

	.committed .state,
	.waiting {
		color: var(--warning);
		font-weight: 800;
	}

	.waiting {
		font-size: var(--step-0);
	}

	.winners {
		list-style: none;
		margin: 0.35rem 0 0;
		padding: 0;
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem 2rem;
	}

	.winners li {
		display: flex;
		align-items: baseline;
		gap: 0.6rem;
	}

	.slot {
		color: var(--room-muted, var(--muted));
		font-weight: 700;
	}

	.coupon {
		font: 800 var(--step-2) / 1 var(--font-display);
		font-variant-numeric: tabular-nums;
		letter-spacing: 0.04em;
	}

	:global(.broadcast) .coupon {
		font-size: clamp(1.5rem, 4.4vh, 2.8rem);
	}

	.name {
		font-size: var(--step-1);
		font-weight: 700;
	}

	:global(.broadcast) .name {
		font-size: clamp(1.1rem, 3vh, 1.8rem);
	}

	.muted {
		color: var(--room-muted, var(--muted));
	}

	.draw {
		min-height: 3rem;
		padding: 0.6rem 1.35rem;
		border: 1px solid var(--room-line, var(--border));
		border-radius: 999px;
		background: transparent;
		color: inherit;
		font: 700 var(--step-0) / 1.1 var(--font-body);
		cursor: pointer;
	}

	.draw.primary {
		min-height: 3.25rem;
		padding: 0.75rem 1.75rem;
		border: 0;
		background: var(--accent);
		color: var(--accent-text, #fff);
		font: 800 var(--step-1) / 1 var(--font-display);
	}

	.draw[disabled] {
		opacity: 0.6;
		cursor: progress;
	}

	@media (max-width: 560px) {
		ol > li,
		:global(.broadcast) ol > li {
			--thumb: 3.25rem;
			grid-template-columns: var(--thumb) minmax(0, 1fr);
			gap: 0.75rem 1rem;
			padding: 1rem;
		}

		.draw {
			grid-column: 1 / -1;
			justify-self: stretch;
		}
	}
</style>
