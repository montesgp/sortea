<script lang="ts">
	import { onMount } from 'svelte';

	interface Props {
		title: string;
		steps: { title: string; body: string }[];
	}

	let { title, steps }: Props = $props();

	let section: HTMLElement;
	let left: SVGGElement;
	let right: SVGGElement;
	let crank: SVGGElement;
	let active = $state(0);
	let scrubbed = $state(false);

	const STROKE = 26;
	const REVOLUTIONS_PER_STEP = 2;

	/** Places both pistons for a crank angle; the two cylinders fire half a turn apart. */
	function render(angle: number) {
		left.setAttribute('transform', `translate(0 ${(-Math.cos(angle) * STROKE).toFixed(2)})`);
		right.setAttribute('transform', `translate(0 ${(-Math.cos(angle + Math.PI) * STROKE).toFixed(2)})`);
		crank.setAttribute('transform', `rotate(${((angle * 180) / Math.PI).toFixed(1)})`);
	}

	onMount(() => {
		if (!document.documentElement.classList.contains('motion')) return;
		let cleanup: (() => void) | undefined;
		let cancelled = false;

		Promise.all([import('gsap'), import('gsap/ScrollTrigger')]).then(([{ gsap }, { ScrollTrigger }]) => {
			if (cancelled) return;
			gsap.registerPlugin(ScrollTrigger);
			scrubbed = true;
			const trigger = ScrollTrigger.create({
				trigger: section,
				start: 'top 60%',
				end: 'bottom 70%',
				scrub: 0.6,
				onUpdate: (self) => {
					render(self.progress * steps.length * REVOLUTIONS_PER_STEP * Math.PI * 2);
					active = Math.min(steps.length - 1, Math.floor(self.progress * steps.length));
				}
			});
			cleanup = () => trigger.kill();
		});

		return () => {
			cancelled = true;
			cleanup?.();
		};
	});
</script>

{#snippet assembly()}
	<!-- Line art echoing the crossed pistons of the logo: crown, rings, pin, rod and big end. -->
	<g class="piston">
		<rect x="-40" y="-178" width="80" height="62" rx="6" />
		<path d="M-40 -164h80M-40 -154h80M-40 -144h80" />
		<circle cx="0" cy="-126" r="9" />
		<path d="M-12 -118 L-17 72 M12 -118 L17 72" />
		<circle cx="0" cy="96" r="34" />
		<circle cx="0" cy="96" r="17" />
		<path d="M-40 92h-10M40 92h10" />
	</g>
{/snippet}

<section class="cycle" class:scrubbed bind:this={section} aria-labelledby="cycle-title">
	<div class="container grid">
		<div class="visual" aria-hidden="true">
			<svg viewBox="-220 -230 440 440" role="presentation">
				<g bind:this={crank} class="crank">
					<circle r="58" />
					<path d="M0 -58V58M-58 0H58" />
				</g>
				<g transform="rotate(-34)"><g bind:this={left}>{@render assembly()}</g></g>
				<g transform="rotate(34)"><g bind:this={right}>{@render assembly()}</g></g>
			</svg>
		</div>

		<div class="steps">
			<h2 id="cycle-title">{title}</h2>
			<ol>
				{#each steps as step, index (step.title)}
					<li class:current={scrubbed && index === active}>
						<span class="number" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
						<div>
							<h3>{step.title}</h3>
							<p>{step.body}</p>
						</div>
					</li>
				{/each}
			</ol>
		</div>
	</div>
</section>

<style>
	.cycle {
		padding-block: clamp(4rem, 3rem + 5vw, 9rem);
		border-top: 1px solid var(--border);
	}

	.grid {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
		gap: clamp(2rem, 1rem + 4vw, 6rem);
		align-items: start;
	}

	.visual {
		position: sticky;
		top: 18vh;
		aspect-ratio: 1;
		max-width: 520px;
		width: 100%;
		justify-self: center;
	}

	svg {
		width: 100%;
		height: 100%;
		overflow: visible;
	}

	.piston :global(*),
	.crank :global(*) {
		fill: none;
		stroke: var(--text);
		stroke-width: 6;
		stroke-linecap: round;
		stroke-linejoin: round;
	}

	.piston :global(rect),
	.piston :global(circle) {
		fill: var(--bg);
	}

	.crank :global(circle) {
		stroke: var(--accent);
		stroke-dasharray: 10 14;
	}

	.crank :global(path) {
		stroke: var(--accent);
		stroke-width: 4;
	}

	h2 {
		font-size: var(--step-4);
		text-transform: uppercase;
		margin-bottom: 2.5rem;
	}

	ol {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
	}

	li {
		display: grid;
		grid-template-columns: 4.5rem 1fr;
		gap: 1rem;
		padding-block: 1.6rem;
		border-top: 1px solid var(--border);
		transition: opacity 300ms;
	}

	.scrubbed li {
		min-height: 42vh;
		align-content: start;
		opacity: 0.35;
	}

	.scrubbed li.current {
		opacity: 1;
	}

	.number {
		font: 800 var(--step-3) / 1 var(--font-display);
		color: var(--accent);
	}

	h3 {
		font-size: var(--step-3);
		text-transform: uppercase;
		margin-bottom: 0.5rem;
	}

	li p {
		color: var(--muted);
		max-width: 40ch;
	}

	@media (max-width: 860px) {
		.grid {
			grid-template-columns: 1fr;
		}

		.visual {
			top: 76px;
			max-width: 240px;
			z-index: 1;
			background: radial-gradient(closest-side, var(--bg) 70%, transparent);
		}

		.scrubbed li {
			min-height: 34vh;
		}
	}
</style>
