<script lang="ts">
	import { onMount } from 'svelte';

	interface Props {
		/** Target instant (ISO, UTC). */
		target: string;
		/** API clock at render time; the countdown follows the server, not the visitor's clock (FR-CMS-03). */
		serverTime: string;
		label: string;
		/** The campaign takes participations now: a green "active" pill and green cells. */
		live?: boolean;
		/** Shown instead of a row of zeros once the target has passed. */
		reached?: string;
	}

	let { target, serverTime, label, live = false, reached }: Props = $props();

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

<div class="countdown" class:live>
	{#if live}<p class="live-pill"><span class="dot" aria-hidden="true"></span>Participación activa</p>{/if}
	{#if remaining === 0 && reached}
		<p class="reached">{reached}</p>
	{:else}
		<div role="timer" aria-label="{label}: {parts[0]?.value} días, {parts[1]?.value} horas y {parts[2]?.value} minutos">
			<p class="label">{label}</p>
			<div class="cells" aria-hidden="true">
				{#each parts as part (part.unit)}
					<span class="cell"><strong>{String(part.value).padStart(2, '0')}</strong><small>{part.unit}</small></span>
				{/each}
			</div>
		</div>
	{/if}
</div>

<style>
	.countdown {
		display: grid;
		gap: 0.75rem;
		justify-items: start;
	}

	/* Green reads as "on" next to any tenant accent; the pulse stops for reduced motion. */
	.live-pill {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		margin: 0;
		padding: 0.3rem 0.85rem;
		border-radius: 999px;
		background: #16a34a;
		color: #fff;
		font-weight: 800;
		font-size: var(--step--1);
		text-transform: uppercase;
		letter-spacing: 0.04em;
		box-shadow: 0 0 0 4px color-mix(in srgb, #16a34a 25%, transparent);
	}

	.dot {
		width: 0.55rem;
		height: 0.55rem;
		border-radius: 50%;
		background: #fff;
		animation: pulse 1.4s ease-in-out infinite;
	}

	@keyframes pulse {
		50% {
			opacity: 0.25;
			transform: scale(0.7);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.dot {
			animation: none;
		}
	}

	.live .cell {
		border-color: color-mix(in srgb, #16a34a 60%, var(--border));
		background: color-mix(in srgb, #16a34a 10%, var(--surface));
	}

	.reached {
		margin: 0;
		font-weight: 700;
		font-size: var(--step-1);
	}

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
