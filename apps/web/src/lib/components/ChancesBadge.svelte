<script lang="ts">
	/**
	 * The chances a purchase earns, as a highlighted ticket (S3): the most
	 * important promise of the platform, so it stands out on cards, in the
	 * chooser and in the cart. The count always comes from the API's locked
	 * rules; this only shows it.
	 */
	let { count, campaign, lead, size = 'card' }: { count: number; campaign: string; lead?: string; size?: 'card' | 'line' | 'total' } = $props();
</script>

<p class="chances-badge {size}">
	<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 8a2 2 0 0 0 2-2h14a2 2 0 0 0 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 0-2 2H5a2 2 0 0 0-2-2v-2a2 2 0 0 0 0-4z" /><path d="M9 6v12" stroke-dasharray="2 2" /></svg>
	<span class="text">
		{#if lead}<span class="lead">{lead}</span>{/if}
		<strong class="count">+{count}</strong>
		<span class="unit">{count === 1 ? 'chance' : 'chances'}</span>
		<span class="for">para {campaign}</span>
	</span>
</p>

<style>
	/* Gold reads as "prize" next to any tenant accent; a tenant theme may set --chances and --chances-text. */
	.chances-badge {
		--gold: var(--chances, #ffc93c);
		position: relative;
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		max-width: 100%;
		padding: 0.4rem 0.85rem 0.4rem 0.6rem;
		overflow: hidden;
		color: var(--chances-text, #231a00);
		background: linear-gradient(135deg, color-mix(in srgb, var(--gold) 82%, white), var(--gold) 45%, color-mix(in srgb, var(--gold) 78%, #ff7a00));
		border: 1px solid color-mix(in srgb, var(--gold) 60%, #7a4b00);
		border-radius: 999px;
		box-shadow:
			0 6px 18px color-mix(in srgb, var(--gold) 40%, transparent),
			inset 0 1px 0 rgb(255 255 255 / 0.55);
		font-size: var(--step--1);
		line-height: 1.2;
	}

	svg {
		flex: none;
		width: 1.25em;
		height: 1.25em;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.8;
		stroke-linejoin: round;
	}

	.text {
		display: inline-flex;
		flex-wrap: wrap;
		align-items: baseline;
		column-gap: 0.3em;
		min-width: 0;
	}

	.count {
		font: 900 1.45em / 1 var(--font-display);
		letter-spacing: -0.01em;
	}

	.unit {
		font-weight: 800;
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}

	.lead,
	.for {
		font-weight: 600;
	}

	/* Where space is short the campaign takes its own line instead of breaking mid-name. */
	.card,
	.total {
		border-radius: var(--radius-sm);
	}

	.card .for,
	.total .for {
		flex-basis: 100%;
	}

	.line {
		padding-block: 0.25rem;
		box-shadow: inset 0 1px 0 rgb(255 255 255 / 0.55);
	}

	.line .count {
		font-size: 1.2em;
	}

	.total {
		display: flex;
		border-radius: var(--radius-sm);
		padding: 0.75rem 1rem;
		font-size: var(--step-0);
	}

	.total .count {
		font-size: 2em;
	}

	@media (prefers-reduced-motion: no-preference) {
		/* A light sweep now and then catches the eye without moving the layout. */
		.chances-badge::after {
			content: '';
			position: absolute;
			inset: 0;
			background: linear-gradient(110deg, transparent 35%, rgb(255 255 255 / 0.65) 50%, transparent 65%);
			transform: translateX(-120%);
			animation: shine 3.6s ease-in-out 0.6s infinite;
			pointer-events: none;
		}

		.count {
			display: inline-block;
			animation: pop 420ms cubic-bezier(0.3, 1.6, 0.5, 1) both;
		}

		@keyframes shine {
			0%,
			55% {
				transform: translateX(-120%);
			}
			100% {
				transform: translateX(120%);
			}
		}

		@keyframes pop {
			from {
				transform: scale(0.6);
				opacity: 0;
			}
		}
	}
</style>
