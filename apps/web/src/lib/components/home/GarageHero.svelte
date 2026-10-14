<script lang="ts">
	import { onMount } from 'svelte';

	interface Props {
		title: string;
		lead: string;
		image: string | null;
		imageAlt: string;
		primary: { href: string; label: string };
		secondary?: { href: string; label: string };
		place?: string;
	}

	let { title, lead, image, imageAlt, primary, secondary, place }: Props = $props();

	let root: HTMLElement;
	let shutter: HTMLElement;
	let photo: HTMLElement;

	const words = $derived(title.split(' '));

	onMount(() => {
		// app.html adds html.motion before first paint when motion is welcome;
		// without it (reduced motion, no JS) the page renders its final state.
		const html = document.documentElement;
		if (!html.classList.contains('motion')) return;
		let context: { revert(): void } | undefined;
		let cancelled = false;

		import('gsap').then(({ gsap }) => {
			if (cancelled || !html.classList.contains('motion')) return;
			html.classList.add('motion-started');
			context = gsap.context(() => {
				const timeline = gsap.timeline({ defaults: { ease: 'power3.out' } });
				timeline
					// The door unlocks: a short drop and settle before it rolls up.
					.to(shutter, { y: 6, duration: 0.18, ease: 'power1.in', delay: 0.25 })
					.to(shutter, { y: 0, duration: 0.22, ease: 'back.out(3)' })
					.to(shutter, { yPercent: -100, duration: 1.5, ease: 'power2.inOut' }, '+=0.05')
					.fromTo(photo, { scale: 1.12, filter: 'brightness(0.35)' }, { scale: 1, filter: 'brightness(1)', duration: 1.9, ease: 'power2.out' }, '<0.1')
					.fromTo('[data-word]', { yPercent: 140 }, { yPercent: 0, duration: 0.9, stagger: 0.07 }, '<0.35')
					.fromTo('[data-reveal]', { y: 18, autoAlpha: 0 }, { y: 0, autoAlpha: 1, duration: 0.7, stagger: 0.1 }, '<0.4');
			}, root);
		});

		return () => {
			cancelled = true;
			context?.revert();
		};
	});
</script>

<section class="hero" bind:this={root} aria-labelledby="hero-title">
	<div class="container layout">
		<div class="copy">
			<h1 id="hero-title">
				{#each words as word, index (index)}
					<span class="word-mask"><span class="word" data-word>{word}</span></span>{' '}
				{/each}
			</h1>
			<p class="lead" data-reveal>{lead}</p>
			<div class="actions" data-reveal>
				<a class="button" href={primary.href}>{primary.label}</a>
				{#if secondary}<a class="button secondary" href={secondary.href}>{secondary.label}</a>{/if}
			</div>
			{#if place}<p class="place muted" data-reveal>{place}</p>{/if}
		</div>

		<div class="door">
			<div class="housing" aria-hidden="true"></div>
			<div class="opening">
				<div class="photo" bind:this={photo}>
					{#if image}
						<picture>
							<source type="image/webp" srcset="{image.replace(/\.jpg$/, '-480.webp')} 480w, {image.replace(/\.jpg$/, '-689.webp')} 689w" sizes="(max-width: 760px) 90vw, 40vw" />
							<img src={image} alt={imageAlt} width="689" height="862" fetchpriority="high" />
						</picture>
					{/if}
				</div>
				<div class="shutter" bind:this={shutter} aria-hidden="true">
					<span class="handle"></span>
				</div>
			</div>
			<div class="floor" aria-hidden="true"></div>
		</div>
	</div>
</section>

<style>
	.hero {
		position: relative;
		overflow: clip;
		padding-block: clamp(2rem, 1rem + 4vw, 5rem) clamp(3rem, 2rem + 4vw, 6rem);
		background:
			radial-gradient(120% 80% at 80% 10%, color-mix(in srgb, var(--accent) 14%, transparent), transparent 60%),
			var(--bg);
	}

	.layout {
		display: grid;
		grid-template-columns: minmax(0, 1.15fr) minmax(0, 0.85fr);
		align-items: center;
		gap: clamp(2rem, 1rem + 4vw, 5rem);
	}

	h1 {
		font-size: var(--step-5);
		line-height: 0.88;
		text-transform: uppercase;
		letter-spacing: -0.005em;
	}

	/* Extra room above the cap height so accents (Á, Ñ) are not clipped by the reveal mask. */
	.word-mask {
		display: inline-block;
		overflow: clip;
		padding-block: 0.16em 0.04em;
		margin-top: -0.16em;
		vertical-align: bottom;
	}

	.word {
		display: inline-block;
	}

	.lead {
		margin-top: 1.5rem;
		max-width: 46ch;
		font-size: var(--step-1);
		color: var(--muted);
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.75rem;
		margin-top: 2rem;
	}

	.place {
		margin-top: 1.5rem;
		font-size: var(--step--1);
	}

	/* The door: a steel frame, a roller housing on top and the photo behind the slats. */
	.door {
		position: relative;
		padding: 14px 14px 0;
		border-radius: 4px 4px 0 0;
		background: linear-gradient(90deg, #2b2e33, #4a4e55 12%, #2b2e33 50%, #4a4e55 88%, #2b2e33);
		box-shadow:
			0 40px 80px -30px rgb(0 0 0 / 0.7),
			inset 0 1px 0 rgb(255 255 255 / 0.12);
	}

	.housing {
		position: absolute;
		inset: 0 0 auto;
		height: 14px;
		background: linear-gradient(180deg, #5a5f67, #2a2d31);
		border-radius: 4px 4px 0 0;
		z-index: 3;
	}

	.opening {
		position: relative;
		aspect-ratio: 689 / 862;
		overflow: hidden;
		background: #0a0b0c;
	}

	.photo,
	.photo img,
	.photo picture {
		width: 100%;
		height: 100%;
	}

	.photo img {
		object-fit: cover;
	}

	.shutter {
		position: absolute;
		inset: 0;
		z-index: 2;
		/* Corrugated galvanized slats: a highlight, a crease and a shadow per slat. */
		background:
			linear-gradient(90deg, rgb(0 0 0 / 0.35), transparent 8%, transparent 92%, rgb(0 0 0 / 0.35)),
			repeating-linear-gradient(
				180deg,
				#8d939b 0px,
				#c3c8ce 3px,
				#9aa0a8 9px,
				#6c7279 15px,
				#4a4f55 18px,
				#7c828a 19px
			);
		box-shadow: inset 0 -6px 0 #3a3e43;
	}

	.handle {
		position: absolute;
		left: 50%;
		bottom: 22px;
		width: 22%;
		height: 10px;
		translate: -50% 0;
		border-radius: 3px;
		background: linear-gradient(180deg, #2f3337, #16181a);
		box-shadow: 0 1px 0 rgb(255 255 255 / 0.25);
	}

	.floor {
		height: 10px;
		margin-inline: -14px;
		background: linear-gradient(180deg, #3b3f45, #1b1d20);
	}

	/* Final state by default: the door is open. html.motion starts it closed for the entrance. */
	.shutter {
		transform: translateY(-100%);
	}

	:global(html.motion) .shutter {
		transform: none;
	}

	:global(html.motion:not(.motion-started)) .word {
		transform: translateY(140%);
	}

	:global(html.motion:not(.motion-started)) [data-reveal] {
		opacity: 0;
	}

	@media (max-width: 860px) {
		.layout {
			grid-template-columns: 1fr;
		}

		.door {
			order: -1;
			width: min(100%, 420px);
			justify-self: center;
		}
	}
</style>
