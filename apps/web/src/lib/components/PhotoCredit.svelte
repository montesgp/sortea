<script lang="ts">
	import { sourceName } from '#lib/gallery.js';
	import type { GalleryCredit } from '#lib/server/types.js';

	/** Photos by others always say who took them, under which license and where they come from. */
	let { credit, photo }: { credit: GalleryCredit; photo: string } = $props();
	const source = $derived(sourceName(credit.sourceUrl));
</script>

<p class="credit">
	Foto: {credit.author} · {credit.license} ·
	<a href={credit.sourceUrl} target="_blank" rel="noopener noreferrer" aria-label="{photo}: foto original en {source}">{source}</a>
</p>

<style>
	.credit {
		margin: 0;
		font-size: var(--step--1);
		color: var(--muted);
		overflow-wrap: anywhere;
	}

	a {
		color: inherit;
	}
</style>
