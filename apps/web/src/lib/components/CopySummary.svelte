<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { copyText } from '#lib/order-summary.js';

	/** Builds the plain text of the purchase when the buyer asks for it (S1, owner feedback 2026-11-11b). */
	let { text }: { text: () => string } = $props();
	let result = $state<'idle' | 'copied' | 'fallback'>('idle');
	let shown = $state('');
	let area = $state<HTMLTextAreaElement>();
	let timer: ReturnType<typeof setTimeout> | undefined;
	// Server-rendered, the button does nothing until the page is interactive: it stays disabled until then.
	let ready = $state(false);
	onMount(() => (ready = true));

	async function copy() {
		clearTimeout(timer);
		shown = text();
		result = await copyText(shown, navigator.clipboard);
		if (result === 'copied') timer = setTimeout(() => (result = 'idle'), 4000);
		else {
			// Without a clipboard the text stays on screen, selected, to copy by hand.
			await tick();
			area?.focus();
			area?.select();
		}
	}
</script>

<div class="copy-summary">
	<div class="row">
		<button type="button" class="button secondary" disabled={!ready} onclick={copy}>Copiar resumen</button>
		<span class="done" role="status">{result === 'copied' ? 'Copiado' : ''}</span>
	</div>
	{#if result === 'fallback'}
		<label for="order-summary-text" class="small">No pudimos copiarlo solo: seleccioná el texto y copialo.</label>
		<textarea id="order-summary-text" readonly rows={shown.split('\n').length} bind:this={area} value={shown}></textarea>
	{/if}
</div>

<style>
	.copy-summary {
		display: grid;
		gap: 0.5rem;
		width: 100%;
	}

	.row {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		flex-wrap: wrap;
	}

	.done {
		color: var(--success);
		font-weight: 700;
	}

	.small {
		font-size: var(--step--1);
	}

	textarea {
		width: 100%;
		font: inherit;
		resize: vertical;
	}
</style>
