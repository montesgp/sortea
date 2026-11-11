<script lang="ts">
	import { fileSize } from '#lib/file-size.js';

	/**
	 * A file input that shows the whole name and size of the chosen file, which the
	 * browser's own box cuts, and a "Quitar" button that discards the choice before
	 * anything is uploaded, without asking (S12, owner feedback 2026-11-10). `current`
	 * names a file already uploaded; removing that one keeps its own action.
	 * The caller keeps the `<label for={id}>` and any hint.
	 */
	interface Props {
		id: string;
		name: string;
		accept?: string;
		required?: boolean;
		current?: { name: string; sizeBytes?: number } | null;
	}

	let { id, name, accept, required = false, current = null }: Props = $props();
	let input: HTMLInputElement | undefined = $state();
	let chosen: { name: string; size: number } | null = $state(null);

	function sync() {
		const file = input?.files?.[0];
		chosen = file ? { name: file.name, size: file.size } : null;
	}

	function discard() {
		if (input) {
			input.value = '';
			input.focus();
		}
		chosen = null;
	}

	// The browser may restore a choice when the page comes back from history.
	$effect(sync);
</script>

<div class="file-input">
	<input bind:this={input} {id} {name} type="file" {accept} {required} aria-describedby="{id}-chosen" onchange={sync} />
	<p id="{id}-chosen" class="summary" aria-live="polite">
		{#if chosen}
			<span class="label">Elegiste:</span> <span class="name">{chosen.name}</span> <span class="size">({fileSize(chosen.size)})</span>
		{:else if current}
			<span class="label">Archivo actual:</span> <span class="name">{current.name}</span>
			{#if current.sizeBytes !== undefined}<span class="size">({fileSize(current.sizeBytes)})</span>{/if}
		{/if}
		<button type="button" class="discard" hidden={!chosen} aria-label={chosen ? `Quitar ${chosen.name}` : undefined} onclick={discard}>Quitar</button>
	</p>
</div>

<style>
	.file-input {
		display: grid;
		gap: 0.3rem;
		min-width: 0;
	}

	.summary {
		margin: 0;
		font-size: var(--step--1);
	}

	.label,
	.size {
		color: var(--muted);
	}

	/* The whole name, wrapped anywhere: file names are long and have no spaces. */
	.name {
		font-weight: 600;
		overflow-wrap: anywhere;
		word-break: break-word;
	}

	.discard {
		margin-left: 0.4rem;
		background: none;
		border: 0;
		padding: 0;
		font: inherit;
		font-weight: 600;
		color: var(--danger);
		text-decoration: underline;
		text-underline-offset: 0.2em;
		cursor: pointer;
	}

	.discard[hidden] {
		display: none;
	}
</style>
