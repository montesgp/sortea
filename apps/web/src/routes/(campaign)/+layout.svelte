<script lang="ts">
	import AnnouncementBar from '#lib/components/AnnouncementBar.svelte';
	import LegalModal from '#lib/components/legal/LegalModal.svelte';
	import SiteFooter from '#lib/components/SiteFooter.svelte';
	import SiteHeader from '#lib/components/SiteHeader.svelte';
	import WhatsAppButton from '#lib/components/WhatsAppButton.svelte';
	import type { LayoutProps } from './$types';

	let { data, children }: LayoutProps = $props();
</script>

{#if data.site}
	<AnnouncementBar announcement={data.site.content.announcement} />
	<SiteHeader site={data.site} cartCount={data.cartCount} mode={data.mode} variant="campaign" />
	<main id="contenido">
		{@render children()}
	</main>
	<SiteFooter site={data.site} />
	<LegalModal />
	<WhatsAppButton number={data.site.contact.whatsapp} />
{/if}
