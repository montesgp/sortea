<script lang="ts">
	/**
	 * A hand tapping the add button it sits on, inviting to buy on a phone (owner feedback
	 * 2026-11-15d S2). Decoration only: hidden from assistive technology, never catching a tap, at
	 * the button's left end so the text stays clear. It taps a few times and then stays still; it
	 * taps again when the call to act brings the button on screen (the `reveal` event of
	 * scrollToSection, which bubbles through the button's form). Still with reduced motion.
	 */
	let root = $state<HTMLSpanElement>();
	let replays = $state(0);

	$effect(() => {
		const scope = root?.parentElement;
		if (!scope) return;
		const replay = () => replays++;
		scope.addEventListener('reveal', replay);
		return () => scope.removeEventListener('reveal', replay);
	});
</script>

<span class="add-nudge" aria-hidden="true" bind:this={root}>
	{#key replays}
		<span class="tap">
			<span class="ring"></span>
			<svg class="hand" viewBox="0 0 24 24">
				<path d="M6 14V4a2 2 0 0 1 4 0v5a2 2 0 0 1 4 0v1a2 2 0 0 1 4 0v1a2 2 0 0 1 4 0v3a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82z" />
				<path d="M10 9v3M14 10v2M18 11v1.5" />
			</svg>
		</span>
	{/key}
</span>

<style>
	/* The fingertip rests on the button's left end, clear of its centered text and of the WhatsApp
	   button floating at the bottom right of the screen; the hand hangs below it. */
	.add-nudge {
		position: absolute;
		left: 0.9rem;
		top: 55%;
		width: 1.75rem;
		pointer-events: none;
		z-index: 1;
	}

	/* A phone affordance (S2): wider screens already show the button on the first screen. */
	@media (min-width: 601px) {
		.add-nudge {
			display: none;
		}
	}

	.tap {
		position: relative;
		display: block;
	}

	.hand {
		display: block;
		width: 100%;
		fill: #fff;
		stroke: #111;
		stroke-width: 1.5;
		stroke-linecap: round;
		stroke-linejoin: round;
		filter: drop-shadow(0 2px 3px rgb(0 0 0 / 0.45));
	}

	/* A ripple where the fingertip touches. */
	.ring {
		position: absolute;
		left: 33%;
		top: 8%;
		width: 1.4rem;
		height: 1.4rem;
		margin: -0.7rem 0 0 -0.7rem;
		border: 2px solid #fff;
		border-radius: 50%;
		opacity: 0;
	}

	@media (prefers-reduced-motion: no-preference) {
		.tap {
			animation: tap 1.2s ease-in-out 0.9s 3;
		}

		.ring {
			animation: ripple 1.2s ease-out 0.9s 3;
		}
	}

	@keyframes tap {
		0%,
		70%,
		100% {
			transform: none;
		}
		35%,
		45% {
			transform: translate(-2px, -5px) scale(0.9);
		}
	}

	@keyframes ripple {
		0%,
		35% {
			opacity: 0;
			transform: scale(0.3);
		}
		45% {
			opacity: 0.9;
		}
		80%,
		100% {
			opacity: 0;
			transform: scale(1.6);
		}
	}
</style>
