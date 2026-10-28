<script lang="ts">
	import '@fontsource-variable/archivo/index';
	import '@fontsource-variable/big-shoulders-display/index';
	import '@fontsource-variable/inter-tight/index';
	import '#lib/styles/app.css';
	import FieldErrors from '#lib/components/FieldErrors.svelte';
	import type { LayoutProps } from './$types';

	let { data, children }: LayoutProps = $props();
	const brand = $derived(data.site?.content.brand);
</script>

<svelte:head>
	<link rel="icon" href={brand?.logo ? brand.logo.replace(/logo\.png$/, 'favicon.png') : '/favicon.png'} />
	<meta name="theme-color" content={data.mode === 'dark' ? '#0E0F11' : '#EFEDE8'} />
</svelte:head>

<a class="skip-link" href="#contenido">Saltar al contenido</a>
<FieldErrors />
{@render children()}
