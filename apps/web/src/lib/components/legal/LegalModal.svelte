<script lang="ts">
	import { page } from '$app/state';
	import LegalDocument from '#lib/components/legal/LegalDocument.svelte';

	/** Shows the legal document a LegalLink opened; closing it goes back to the page it was opened from. */
	let dialog = $state<HTMLDialogElement>();
	const doc = $derived(page.state.legal);

	$effect(() => {
		if (!dialog) return;
		if (doc && !dialog.open) dialog.showModal();
		if (!doc && dialog.open) dialog.close();
	});

	function onclose() {
		// Closed with Escape or the button while its history entry is current.
		if (page.state.legal) history.back();
	}
</script>

<dialog bind:this={dialog} class="legal" aria-labelledby="legal-title" {onclose}>
	{#if doc}
		<header>
			<h2 id="legal-title">{doc.title}</h2>
			<button type="button" class="close" aria-label="Cerrar" onclick={() => dialog?.close()}>
				<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
			</button>
		</header>
		<div class="prose body">
			<LegalDocument {doc} />
		</div>
		<footer>
			<button type="button" class="button" onclick={() => dialog?.close()}>Entendido</button>
		</footer>
	{/if}
</dialog>

<style>
	.legal {
		width: min(100% - 2rem, 46rem);
		max-height: calc(100dvh - 2rem);
		padding: 0;
		color: var(--text);
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		box-shadow: 0 24px 60px rgb(0 0 0 / 0.35);
	}

	.legal::backdrop {
		background: rgb(0 0 0 / 0.55);
	}

	.legal[open] {
		display: grid;
		grid-template-rows: auto minmax(0, 1fr) auto;
	}

	header,
	footer {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		padding: 1rem 1.5rem;
	}

	header {
		border-bottom: 1px solid var(--border);
	}

	footer {
		justify-content: flex-end;
		border-top: 1px solid var(--border);
	}

	h2 {
		font-size: var(--step-2);
		text-transform: uppercase;
	}

	.body {
		overflow-y: auto;
		padding: 1rem 1.5rem 1.5rem;
	}

	.close {
		display: grid;
		place-items: center;
		flex: none;
		width: 44px;
		height: 44px;
		color: inherit;
		background: transparent;
		border: 0;
		border-radius: var(--radius-sm);
		cursor: pointer;
	}

	.close svg {
		width: 22px;
		fill: none;
		stroke: currentColor;
		stroke-width: 2.5;
		stroke-linecap: round;
	}
</style>
