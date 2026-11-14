<script lang="ts">
	import type { ExtractRow } from '#lib/draw-room.js';

	/**
	 * The 20 positions of the Quiniela (odd/tasks/draw-room.md T5, S4): one
	 * 4-digit field each while they are typed, or the recorded numbers. Each
	 * position says at once what its number did, as the API matched it.
	 */
	let {
		rows,
		editable,
		oninput,
		onkeydown
	}: {
		rows: readonly ExtractRow[];
		editable: boolean;
		oninput?: (index: number, value: string) => void;
		onkeydown?: (index: number, event: KeyboardEvent) => void;
	} = $props();
</script>

<ol class="extracts" class:editable>
	{#each rows as row, index (row.position)}
		<li class={row.state}>
			{#if editable}
				<label for="extract-{row.position}">{row.label}</label>
				<input
					id="extract-{row.position}"
					type="text"
					inputmode="numeric"
					pattern="[0-9]*"
					maxlength="4"
					autocomplete="off"
					spellcheck="false"
					placeholder="0000"
					value={row.value}
					aria-describedby="extract-{row.position}-outcome"
					oninput={(event) => oninput?.(index, event.currentTarget.value)}
					onkeydown={(event) => onkeydown?.(index, event)}
				/>
			{:else}
				<span class="label">{row.label}</span>
				<span class="number">{row.value}</span>
			{/if}
			<span id="extract-{row.position}-outcome" class="outcome">{row.outcome ?? ''}</span>
		</li>
	{/each}
</ol>

<style>
	.extracts {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(9.5rem, 1fr));
		gap: 0.5rem;
	}

	li {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr);
		align-items: center;
		gap: 0.15rem 0.5rem;
		padding: 0.45rem 0.6rem;
		border: 1px solid var(--room-line, var(--border));
		border-left-width: 4px;
		border-radius: var(--radius-sm);
		background: var(--room-cell, var(--surface));
	}

	label,
	.label {
		font-weight: 700;
		font-size: var(--step--1);
		color: var(--room-muted, var(--muted));
		min-width: 2.4em;
	}

	input,
	.number {
		width: 100%;
		min-width: 0;
		font: 800 var(--step-2) / 1.1 var(--font-display);
		font-variant-numeric: tabular-nums;
		letter-spacing: 0.06em;
	}

	input {
		padding: 0.2rem 0.4rem;
		border: 1px solid var(--room-line, var(--border));
		border-radius: var(--radius-sm);
		background: transparent;
		color: inherit;
	}

	input:focus-visible {
		outline: 3px solid var(--accent);
		outline-offset: 1px;
	}

	.outcome {
		grid-column: 1 / -1;
		min-height: 1.2em;
		font-size: 0.8rem;
		font-weight: 600;
		color: var(--room-muted, var(--muted));
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.won {
		border-left-color: var(--accent);
	}

	.won .outcome {
		color: var(--accent);
	}

	.alternate {
		border-left-color: var(--room-muted, var(--muted));
	}

	.waiting .outcome {
		color: var(--warning);
	}
</style>
