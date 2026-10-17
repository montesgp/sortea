<script lang="ts">
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	// A rejected number stays in the field to be corrected; otherwise show the saved one.
	const whatsappValue = $derived(form && 'whatsapp' in form ? form.whatsapp : data.settings.contact.whatsapp ? `+${data.settings.contact.whatsapp}` : '');
</script>

<svelte:head>
	<title>Configuración | Panel</title>
</svelte:head>

<h1>Configuración</h1>

<section class="panel" aria-labelledby="contact-title">
	<h2 id="contact-title">Contacto</h2>
	<p class="muted small">El número de WhatsApp se muestra como botón en todas las páginas públicas del sitio. Dejalo vacío para ocultarlo.</p>
	{#if form?.message}<p class="notice {form.ok ? 'ok' : 'error'}" role={form.ok ? 'status' : 'alert'}>{form.message}</p>{/if}
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
