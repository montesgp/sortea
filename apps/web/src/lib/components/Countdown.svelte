<script lang="ts">
	import { onMount } from 'svelte';

	interface Props {
		/** Target instant (ISO, UTC). */
		target: string;
		/** API clock at render time; the countdown follows the server, not the visitor's clock (FR-CMS-03). */
		serverTime: string;
		label: string;
	}

	let { target, serverTime, label }: Props = $props();

	// Starts at the server clock so the server render and hydration agree.
	let now = $state(0);
	const current = $derived(now || new Date(serverTime).getTime());

	onMount(() => {
		const offset = new Date(serverTime).getTime() - Date.now();
		const tick = () => (now = Date.now() + offset);
		tick();
		const timer = setInterval(tick, 1000);
		return () => clearInterval(timer);
	});

	const remaining = $derived(Math.max(0, new Date(target).getTime() - current));
	const parts = $derived([
		{ value: Math.floor(remaining / 86_400_000), unit: 'días' },
		{ value: Math.floor((remaining / 3_600_000) % 24), unit: 'horas' },
		{ value: Math.floor((remaining / 60_000) % 60), unit: 'min' },
		{ value: Math.floor((remaining / 1000) % 60), unit: 'seg' }
	]);
</script>

<div class="countdown" role="timer" aria-label="{label}: {parts[0]?.value} días, {parts[1]?.value} horas y {parts[2]?.value} minutos">
	<p class="label">{label}</p>
	<div class="cells" aria-hidden="true">
		{#each parts as part (part.unit)}
			<span class="cell"><strong>{String(part.value).padStart(2, '0')}</strong><small>{part.unit}</small></span>
		{/each}
	</div>
</div>

<style>
	.label {
		font-size: var(--step--1);
		color: var(--muted);
		margin-bottom: 0.5rem;
	}

	.cells {
		display: flex;
		gap: 0.5rem;
	}

	.cell {
		display: grid;
		justify-items: center;
		min-width: 4.2rem;
		padding: 0.6rem 0.4rem 0.45rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		background: var(--surface);
	}

	strong {
		font: 800 var(--step-3) / 1 var(--font-display);
		font-variant-numeric: tabular-nums;
	}

	small {
		font-size: 0.72rem;
		color: var(--muted);
	}
</style>
