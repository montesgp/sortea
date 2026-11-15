<script lang="ts">
	import type { GalleryMedia } from '#lib/server/types.js';

	/**
	 * A prize's photos and videos, like an online store's product page
	 * (owner-feedback-2026-11-14 S7): one large viewer and a strip of thumbnails.
	 * Arrows, the arrow keys and a horizontal swipe move between items; a video
	 * plays only when asked, inline and with its controls. Leaving a video
	 * removes it, so it stops.
	 */
	let { items, title }: { items: GalleryMedia[]; title: string } = $props();

	let current = $state(0);
	const index = $derived(Math.min(current, items.length - 1));
	const item = $derived(items[index]!);
	const thumbs: HTMLButtonElement[] = $state([]);
	let touchX: number | null = null;

	const label = (entry: GalleryMedia, position: number) => `Ver ${entry.kind === 'video' ? 'video' : 'foto'} ${position + 1} de ${items.length}: ${entry.alt}`;

	function show(next: number) {
		current = (next + items.length) % items.length;
	}

	function onkeydown(event: KeyboardEvent) {
		// A focused video keeps its own arrow keys (seeking).
		if (event.target instanceof HTMLVideoElement || items.length < 2) return;
		const moves: Record<string, number> = { ArrowLeft: index - 1, ArrowRight: index + 1, Home: 0, End: items.length - 1 };
		if (!(event.key in moves)) return;
		event.preventDefault();
		show(moves[event.key]!);
		if (event.target instanceof HTMLButtonElement && thumbs.includes(event.target)) thumbs[current]?.focus();
	}

	function ontouchstart(event: TouchEvent) {
		touchX = event.target instanceof HTMLVideoElement ? null : (event.touches[0]?.clientX ?? null);
	}

	function ontouchend(event: TouchEvent) {
		const end = event.changedTouches[0]?.clientX;
		if (touchX === null || end === undefined) return;
		const distance = end - touchX;
		touchX = null;
		if (Math.abs(distance) > 40) show(index + (distance < 0 ? 1 : -1));
	}
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<section class="gallery" aria-label="Fotos y videos de {title}" {onkeydown}>
	<!-- Swiping only adds to the arrow buttons and the thumbnails, which do the same. -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="stage" {ontouchstart} {ontouchend}>
		{#key index}
			{#if item.kind === 'video'}
				<!-- Clips of the prize, without speech to caption. -->
				<!-- svelte-ignore a11y_media_has_caption -->
				<video src={item.url} controls playsinline preload="metadata" aria-label={item.alt}></video>
			{:else}
				<img src={item.url} alt={item.alt} decoding="async" loading={index === 0 ? 'eager' : 'lazy'} />
			{/if}
		{/key}
		{#if items.length > 1}
			<button class="nav prev" type="button" aria-label="Anterior" onclick={() => show(index - 1)}><span aria-hidden="true">‹</span></button>
			<button class="nav next" type="button" aria-label="Siguiente" onclick={() => show(index + 1)}><span aria-hidden="true">›</span></button>
			<p class="count" aria-live="polite">{index + 1} / {items.length}</p>
		{/if}
	</div>
	{#if items.length > 1}
		<ul class="thumbs">
			{#each items as entry, position (position)}
				<li>
					<button type="button" class="thumb" bind:this={thumbs[position]} aria-label={label(entry, position)} aria-current={position === index ? 'true' : undefined} onclick={() => show(position)}>
						{#if entry.kind === 'video'}
							<!-- Only its first frame, as the thumbnail. -->
							<video src="{entry.url}#t=0.1" preload="metadata" muted playsinline tabindex="-1" aria-hidden="true"></video>
							<span class="play" aria-hidden="true"></span>
						{:else}
							<img src={entry.url} alt="" loading="lazy" decoding="async" />
						{/if}
					</button>
				</li>
			{/each}
		</ul>
	{/if}
</section>

<style>
	.gallery {
		display: grid;
		gap: 0.75rem;
		min-width: 0;
	}

	/* One frame for photos and videos of any orientation: nothing is cropped. */
	.stage {
		position: relative;
		aspect-ratio: 4 / 3;
		border-radius: var(--radius);
		overflow: hidden;
		background: #0b0c0d;
		touch-action: pan-y;
	}

	.stage img,
	.stage video {
		width: 100%;
		height: 100%;
		object-fit: contain;
	}

	.nav {
		position: absolute;
		top: 50%;
		translate: 0 -50%;
		display: grid;
		place-items: center;
		width: 44px;
		height: 44px;
		padding: 0;
		border: 0;
		border-radius: 50%;
		background: rgb(11 12 13 / 0.65);
		color: #fff;
		font: 400 2rem / 1 var(--font-body);
		cursor: pointer;
	}

	.nav:hover {
		background: rgb(11 12 13 / 0.85);
	}

	.prev {
		left: 0.5rem;
	}

	.next {
		right: 0.5rem;
	}

	.nav span {
		margin-top: -0.15em;
	}

	.count {
		position: absolute;
		top: 0.6rem;
		right: 0.6rem;
		padding: 0.15rem 0.6rem;
		border-radius: 999px;
		background: rgb(11 12 13 / 0.65);
		color: #fff;
		font-size: var(--step--1);
		font-variant-numeric: tabular-nums;
	}

	/* The strip scrolls inside its box; the page never widens. */
	.thumbs {
		display: flex;
		gap: 0.5rem;
		margin: 0;
		padding: 3px;
		list-style: none;
		overflow-x: auto;
		scroll-snap-type: x proximity;
		scrollbar-width: thin;
	}

	.thumbs li {
		flex: none;
		scroll-snap-align: start;
	}

	.thumb {
		position: relative;
		display: block;
		width: 76px;
		aspect-ratio: 4 / 3;
		padding: 0;
		border: 2px solid transparent;
		border-radius: var(--radius-sm);
		overflow: hidden;
		background: #0b0c0d;
		cursor: pointer;
		opacity: 0.7;
		transition: opacity 160ms;
	}

	.thumb:hover,
	.thumb[aria-current='true'] {
		opacity: 1;
	}

	.thumb[aria-current='true'] {
		border-color: var(--accent);
	}

	.thumb img,
	.thumb video {
		width: 100%;
		height: 100%;
		object-fit: cover;
		pointer-events: none;
	}

	.play {
		position: absolute;
		inset: 50% auto auto 50%;
		translate: -50% -50%;
		width: 28px;
		height: 28px;
		border-radius: 50%;
		background: rgb(11 12 13 / 0.7);
	}

	.play::after {
		content: '';
		position: absolute;
		top: 50%;
		left: 55%;
		translate: -50% -50%;
		border-block: 6px solid transparent;
		border-left: 10px solid #fff;
	}
</style>
