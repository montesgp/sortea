<script lang="ts">
	import SiteFooter from '#lib/components/SiteFooter.svelte';
	import SiteHeader from '#lib/components/SiteHeader.svelte';
	import type { LayoutProps } from './$types';

	let { data, children }: LayoutProps = $props();
</script>

{#if data.site}
	<SiteHeader site={data.site} cartCount={data.cartCount} mode={data.mode} variant="campaign" />
	<main id="contenido">
		{@render children()}
	</main>
	<SiteFooter site={data.site} />
{/if}
