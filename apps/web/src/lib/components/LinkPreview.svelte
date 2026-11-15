<script lang="ts">
	/**
	 * What a shared link shows on WhatsApp, Facebook, X and the like (owner feedback 2026-11-15c S1):
	 * the Open Graph tags and the Twitter card. `url` and `image` must be absolute.
	 */
	let {
		title,
		description,
		url,
		image = null,
		siteName
	}: { title: string; description: string; url: string; image?: string | null; siteName: string } = $props();
</script>

<svelte:head>
	<meta property="og:type" content="website" />
	<meta property="og:site_name" content={siteName} />
	<meta property="og:title" content={title} />
	<meta property="og:description" content={description} />
	<meta property="og:url" content={url} />
	{#if image}
		<meta property="og:image" content={image} />
		<meta property="og:image:alt" content={title} />
	{/if}
	<meta name="twitter:card" content={image ? 'summary_large_image' : 'summary'} />
</svelte:head>
