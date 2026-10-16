<script lang="ts">
	import type { PublicVideo } from '@sortea/domain';

	/**
	 * A video of what is raffled (S9), already resolved by the API: a clip from
	 * the public media bucket or the privacy-enhanced YouTube embed. Nothing
	 * plays on its own; uploads only fetch their metadata until played.
	 */
	let { video, title }: { video: PublicVideo; title: string } = $props();
</script>

<div class="player">
	{#if video.kind === 'upload'}
		<!-- Short clips of the prize, without speech to caption. -->
		<!-- svelte-ignore a11y_media_has_caption -->
		<video controls preload="metadata" playsinline aria-label={title}>
			<source src={video.url} type={video.contentType} />
		</video>
	{:else}
		<iframe src={video.embedUrl} {title} loading="lazy" allow="encrypted-media; picture-in-picture" allowfullscreen></iframe>
	{/if}
</div>

<style>
	.player {
		width: 100%;
		aspect-ratio: 16 / 9;
		border-radius: var(--radius);
		overflow: hidden;
		background: #000;
	}

	video,
	iframe {
		display: block;
		width: 100%;
		height: 100%;
		border: 0;
		object-fit: contain;
	}
</style>
