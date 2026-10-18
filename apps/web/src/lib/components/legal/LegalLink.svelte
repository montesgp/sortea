<script lang="ts">
	import type { Snippet } from 'svelte';
	import { goto, preloadData, pushState } from '$app/navigation';

	/**
	 * A link to a legal document that opens it in a modal over the current page
	 * (S4, feedback 2026-10-18), so the buyer never leaves a checkout half done.
	 * The address changes, so Back closes it; without JavaScript, or with a
	 * modifier key, it is an ordinary link to the page.
	 */
	let { href, children }: { href: string; children: Snippet } = $props();

	async function open(event: MouseEvent) {
		if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
		event.preventDefault();
		const result = await preloadData(href);
		if (result.type === 'loaded' && result.status === 200) pushState(href, { legal: result.data as App.PageState['legal'] });
		else await goto(href);
	}
</script>

<a {href} onclick={open}>{@render children()}</a>
