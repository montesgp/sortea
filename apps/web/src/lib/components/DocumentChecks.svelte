<script lang="ts">
	import type { DocumentCheck } from '#lib/document-field.js';

	/**
	 * The requirements of the document number for its type, each ticked green
	 * while it is typed, like a password rule list (owner feedback 2026-11-15
	 * S8, and in Consultar 2026-11-15b S1). The input it describes points here
	 * with `aria-describedby`.
	 */
	let { id, checks }: { id: string; checks: readonly DocumentCheck[] } = $props();
</script>

<ul class="checks" {id} aria-live="polite">
	{#each checks as check (check.label)}
		<li class:ok={check.ok}>{check.label}{#if check.ok}<span class="visually-hidden"> (cumple)</span>{/if}</li>
	{/each}
</ul>

<style>
	.checks {
		list-style: none;
		margin: 0.35rem 0 0;
		padding: 0;
		display: flex;
		flex-wrap: wrap;
		gap: 0.2rem 1rem;
		font-size: var(--step--1);
		color: var(--muted);
	}

	li::before {
		content: '○';
		display: inline-block;
		width: 1.1em;
	}

	li.ok {
		color: var(--success);
	}

	li.ok::before {
		content: '✓';
		font-weight: 700;
	}
</style>
