<script lang="ts">
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const name = $derived(data.site?.organization.name ?? '');
</script>

<svelte:head>
	<title>{data.title} | {name}</title>
</svelte:head>

<article class="container page prose">
	<h1>{data.title}</h1>
	{#if data.sections}
		<p class="muted">Versión {data.version}</p>
		{#each data.sections as section, index (index)}
			<h2>{section.title}</h2>
			{@html section.html}
		{/each}
	{:else}
		<p class="notice">Versión {data.version}. Este texto es un borrador y se reemplaza por el documento revisado por asesoría legal antes de habilitar ventas reales.</p>

		{#if data.kind === 'privacidad'}
			<h2>Qué datos usamos</h2>
			<p>Nombre, apellido, documento, email y, si lo das, teléfono y dirección de entrega. Los usamos para procesar tu compra, enviarte el comprobante y los archivos, y permitirte consultar tus compras.</p>
			<h2>Qué no hacemos</h2>
			<p>No publicamos tu documento ni tus datos. Las listas públicas de participaciones usan identificadores seudónimos que no permiten saber quién sos.</p>
			<h2>Comunicaciones</h2>
			<p>Solo te enviamos novedades si lo aceptaste expresamente. Podés retirar ese consentimiento cuando quieras.</p>
			<h2>Tus derechos</h2>
			<p>Podés pedir acceso, rectificación o supresión de tus datos según la Ley 25.326. La Agencia de Acceso a la Información Pública es el órgano de control.</p>
		{:else}
			<h2>Compra</h2>
			<p>Los precios incluyen impuestos y se confirman al momento de pagar. La compra se confirma cuando Mercado Pago aprueba el pago.</p>
			<h2>Productos digitales</h2>
			<p>Se entregan por email con enlaces que vencen y se pueden volver a pedir desde Consultar.</p>
			<h2>Productos físicos</h2>
			<p>Se retiran o se envían según la opción elegida. El costo de envío se informa antes de pagar.</p>
			<h2>Arrepentimiento</h2>
			<p>Podés revocar la compra dentro de los 10 días corridos según la Ley 24.240 de Defensa del Consumidor.</p>
		{/if}
	{/if}
</article>

<style>
	.page {
		padding-top: clamp(2.5rem, 2rem + 3vw, 5rem);
	}

	h1 {
		font-size: var(--step-4);
		text-transform: uppercase;
		margin-bottom: 1.5rem;
	}

	.notice {
		margin-bottom: 2rem;
	}
</style>
