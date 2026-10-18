<script lang="ts">
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	// A rejected number stays in the field to be corrected; otherwise show the saved one.
	const whatsappValue = $derived(form && 'whatsapp' in form ? form.whatsapp : data.settings.contact.whatsapp ? `+${data.settings.contact.whatsapp}` : '');
	const social = $derived(form && 'social' in form ? form.social : null);
	const networks = [
		{ key: 'instagram', label: 'Instagram', placeholder: 'https://www.instagram.com/tu-cuenta/' },
		{ key: 'tiktok', label: 'TikTok', placeholder: 'https://www.tiktok.com/@tu-cuenta' },
		{ key: 'youtube', label: 'YouTube', placeholder: 'https://www.youtube.com/@tu-canal' },
		{ key: 'facebook', label: 'Facebook', placeholder: 'https://www.facebook.com/tu-pagina' }
	] as const;
	const linkValue = (key: (typeof networks)[number]['key']) => (social ? (social.links as Record<string, string>)[key] : (data.settings.social?.[key] ?? ''));
	const linkError = (key: string) => (social?.errors as Record<string, string> | undefined)?.[key];
</script>

<svelte:head>
	<title>Configuración | Panel</title>
</svelte:head>

<h1>Configuración</h1>

<section class="panel" aria-labelledby="contact-title">
	<h2 id="contact-title">Contacto</h2>
	<p class="muted small">El número de WhatsApp se muestra como botón en todas las páginas públicas del sitio. Dejalo vacío para ocultarlo.</p>
	{#if form && 'message' in form && form.message}<p class="notice {form.ok ? 'ok' : 'error'}" role={form.ok ? 'status' : 'alert'}>{form.message}</p>{/if}
	<form method="POST" action="?/contact" class="stack">
		<div class="field">
			<label for="whatsapp">WhatsApp</label>
			<input
				id="whatsapp"
				name="whatsapp"
				type="tel"
				inputmode="tel"
				autocomplete="off"
				placeholder="+54 9 2478 40-7084"
				defaultValue={whatsappValue}
				aria-describedby="whatsapp-hint"
			/>
			<p id="whatsapp-hint" class="muted small">Con código de país; para celulares de Argentina, +54 9 y el código de área.</p>
		</div>
		<button class="button small">Guardar contacto</button>
	</form>
</section>

<section class="panel" aria-labelledby="social-title">
	<h2 id="social-title">Redes sociales</h2>
	<p class="muted small">Se muestran en la página de inicio y al pie de todas las páginas. Dejá vacía una red para ocultarla.</p>
	{#if social}<p class="notice {social.ok ? 'ok' : 'error'}" role={social.ok ? 'status' : 'alert'}>{social.message}</p>{/if}
	<form method="POST" action="?/social" class="stack wide">
		{#each networks as network (network.key)}
			<div class="field">
				<label for="social-{network.key}">{network.label}</label>
				<input id="social-{network.key}" name={network.key} type="url" inputmode="url" autocomplete="off" placeholder={network.placeholder} defaultValue={linkValue(network.key)} aria-invalid={Boolean(linkError(network.key))} aria-describedby="social-{network.key}-error" />
				{#if linkError(network.key)}<p class="error" id="social-{network.key}-error">{linkError(network.key)}</p>{/if}
			</div>
		{/each}
		<button class="button small">Guardar redes</button>
	</form>
</section>

<style>
	h1 {
		font-size: var(--step-4);
		text-transform: uppercase;
		margin-bottom: 1.5rem;
	}

	h2 {
		font-size: var(--step-1);
		text-transform: uppercase;
	}

	.panel {
		display: grid;
		gap: 0.9rem;
		align-content: start;
		max-width: 520px;
	}

	.panel + .panel {
		margin-top: 2rem;
	}

	.stack.wide {
		justify-items: stretch;
	}

	.stack.wide .button {
		justify-self: start;
	}

	.stack {
		display: grid;
		gap: 0.9rem;
		justify-items: start;
	}

	.stack .field {
		width: 100%;
	}

	.small {
		font-size: var(--step--1);
	}
</style>
