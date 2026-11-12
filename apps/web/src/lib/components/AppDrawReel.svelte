<script lang="ts">
	import { REEL_RADIUS, reelWindow, type AppDrawCandidate } from '#lib/app-draw.js';

	/**
	 * The reel of the in-app draw (ADR 0024 §5): the rows near the centre of
	 * `strip` at `position`, and nothing else, so thousands of coupons stay
	 * smooth. Rows move by transforms only; the centre window is fixed. Hidden
	 * from screen readers: the page announces each result in words.
	 */
	let { strip, position, landed = false }: { strip: readonly AppDrawCandidate[]; position: number; landed?: boolean } = $props();
	const rows = $derived(strip.length ? reelWindow(position, strip.length) : []);
	const fade = (offset: number) => Math.max(0.12, 1 - (Math.abs(offset) / (REEL_RADIUS + 1)) * 0.9);
	// Neighbours shrink a little with their distance from the centre; transforms only.
	const scale = (offset: number) => Math.max(0.7, 1 - Math.abs(offset) * 0.09);
</script>

<div class="reel" class:landed aria-hidden="true">
	{#each rows as row (row.row)}
		{@const candidate = strip[row.index]!}
		<div class="reel-row" class:centre={Math.abs(row.offset) < 0.5} style:transform="translate3d(0, {row.offset * 100}%, 0) scale({scale(row.offset)})" style:opacity={fade(row.offset)}>
			<span class="number">{candidate.entryNumber}</span>
			<span class="name">{candidate.maskedName}</span>
		</div>
	{/each}
	<div class="window"></div>
</div>

<style>
	.reel {
		position: relative;
		height: 100%;
		min-height: 18rem;
		overflow: hidden;
		/*
		 * Row height from the viewport, not the reel's box: the reel reads the same
		 * before and during the spin (about 45 px numbers at 720p). Rows beyond the
		 * box are clipped.
		 */
		--row: clamp(2.75rem, min(9vh, 15vw), 6.5rem);
		/* The rows fade into the asphalt at both ends. */
		mask-image: linear-gradient(to bottom, transparent, #000 18%, #000 82%, transparent);
	}

	.reel-row {
		position: absolute;
		inset-inline: 0;
		top: calc(50% - var(--row) / 2);
		height: var(--row);
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.6em;
		font-size: calc(var(--row) * 0.7);
		line-height: 1;
		white-space: nowrap;
		will-change: transform;
		color: var(--stage-muted);
	}

	.number {
		font-family: var(--font-display);
		font-weight: 800;
		font-variant-numeric: tabular-nums;
		letter-spacing: 0.04em;
	}

	.name {
		font-size: 0.6em;
		font-weight: 600;
		min-width: 6.5em;
	}

	.reel-row.centre {
		color: var(--stage-text);
	}

	.landed .reel-row.centre .number {
		color: var(--accent);
	}

	/* The centre window: a finish line above and below the row that wins. */
	.window {
		position: absolute;
		inset-inline: 0;
		top: calc(50% - var(--row) / 2);
		height: var(--row);
		pointer-events: none;
		border-block: 0.35rem solid transparent;
		border-image: repeating-linear-gradient(90deg, var(--stage-text) 0 0.7rem, var(--stage-ink) 0.7rem 1.4rem) 1;
		background: color-mix(in srgb, var(--accent) 14%, transparent);
		transition: background-color 0.6s var(--ease-out);
	}

	.landed .window {
		background: color-mix(in srgb, var(--accent) 28%, transparent);
	}
</style>
