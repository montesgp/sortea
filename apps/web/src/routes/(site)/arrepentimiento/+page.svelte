<script lang="ts">
	import { onMount } from 'svelte';
	import { whatsappHref } from '#lib/whatsapp.js';
	import { NAME_MAX, readWithdrawalRequest, withdrawalHref } from '#lib/withdrawal.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const site = $derived(data.site!);
	const hasWhatsApp = $derived(Boolean(whatsappHref(site.contact.whatsapp)));

	// Without JavaScript the form posts and the page answers with the link to open.
	// With JavaScript the button is that link, rebuilt as the buyer types.
	let enhanced = $state(false);
	onMount(() => (enhanced = true));
	const initial = () => form?.values ?? { reference: '', name: '' };
	let reference = $state(initial().reference);
	let name = $state(initial().name);
	let clientErrors: { reference?: string; name?: string } = $state({});
	const errors: { reference?: string; name?: string } = $derived(enhanced ? clientErrors : (form?.errors ?? {}));
	const liveHref = $derived(withdrawalHref(site.contact.whatsapp, readWithdrawalRequest({ reference, name }).values));

	function check(event: MouseEvent) {
		const read = readWithdrawalRequest({ reference, name });
		clientErrors = read.ok ? {} : read.errors;
		if (!read.ok) event.preventDefault();
	}
</script>

<svelte:head>
	<title>Botón de arrepentimiento | {site.organization.name}</title>
	<meta name="description" content="Revocá tu compra dentro de los 10 días corridos, sin costo y sin registrarte." />
</svelte:head>

<section class="container page">
	<h1>Botón de arrepentimiento</h1>
	<p class="lead">
		Podés revocar tu compra dentro de los 10 días corridos desde la compra o desde la entrega, lo que ocurra último, sin costo y sin
		explicar el motivo (Ley 24.240, artículo 34, y Resolución 424/2020). No necesitás registrarte.
	</p>

	<div class="layout">
		<!-- The numbers are drawn, not list markers, so they line up with the lead paragraph (2026-10-30). -->
		<ol class="steps">
			<li><span class="number" aria-hidden="true">1</span><span>Completá el comprobante de la compra, si lo tenés, y tu nombre.</span></li>
			{#if hasWhatsApp}
				<li><span class="number" aria-hidden="true">2</span><span>Tocá el botón: se abre WhatsApp con el mensaje preparado. Revisalo y envialo.</span></li>
			{:else}
				<li><span class="number" aria-hidden="true">2</span><span>Escribinos por los canales de contacto que figuran en esta página.</span></li>
			{/if}
			<li>
				<span class="number" aria-hidden="true">3</span><span>{site.organization.name} te responde por WhatsApp y te da un código de seguimiento de tu solicitud dentro de las 24 horas.</span>
			</li>
		</ol>

		<div class="panel">
			{#if hasWhatsApp}
				{#if !enhanced && form?.href}
					<div class="notice ok ready" role="status">
						<p>Tu mensaje está listo. Abrí WhatsApp y envialo.</p>
						<a class="button" href={form.href} target="_blank" rel="noopener">Abrir WhatsApp con el mensaje</a>
					</div>
				{/if}
				<form method="POST" class="stack">
					<div class="field">
						<label for="reference">Comprobante <span class="muted">(opcional)</span></label>
						<input
							id="reference"
							name="reference"
							placeholder="XX-XXXXXXXX"
							autocapitalize="characters"
							autocomplete="off"
							maxlength="24"
							bind:value={reference}
							aria-invalid={Boolean(errors.reference)}
							aria-describedby={errors.reference ? 'reference-error' : 'reference-hint'}
						/>
						{#if errors.reference}
							<p class="error" id="reference-error">{errors.reference}</p>
						{:else}
							<p class="hint" id="reference-hint">Figura al terminar la compra y en el email de confirmación.</p>
						{/if}
					</div>
					<div class="field">
						<label for="name">Nombre y apellido <span class="muted">(opcional)</span></label>
						<input
							id="name"
							name="name"
							autocomplete="name"
							maxlength={NAME_MAX}
							bind:value={name}
							aria-invalid={Boolean(errors.name)}
							aria-describedby={errors.name ? 'name-error' : undefined}
						/>
						{#if errors.name}<p class="error" id="name-error">{errors.name}</p>{/if}
					</div>
					{#if enhanced && liveHref}
						<a class="button" href={liveHref} target="_blank" rel="noopener" onclick={check}>Solicitar el arrepentimiento por WhatsApp</a>
					{:else}
						<button class="button">Solicitar el arrepentimiento por WhatsApp</button>
					{/if}
					<p class="muted small">El mensaje se arma solo para WhatsApp: este sitio no guarda lo que escribas acá.</p>
				</form>
			{:else}
				<h2>Canales de contacto</h2>
				<p>Escribinos indicando el comprobante de la compra y tu nombre.</p>
				<ul class="contact">
					{#if site.contact.email}<li>Email: <a href="mailto:{site.contact.email}">{site.contact.email}</a></li>{/if}
					{#if site.contact.phone}<li>Teléfono: <a href="tel:{site.contact.phone.replace(/[^\d+]/g, '')}">{site.contact.phone}</a></li>{/if}
					{#if site.contact.address}<li>Dirección: {site.contact.address}</li>{/if}
				</ul>
				{#if !site.contact.email && !site.contact.phone && !site.contact.address}
					<p class="muted">Usá los canales que figuran al pie de esta página.</p>
				{/if}
			{/if}
		</div>
	</div>
</section>

<style>
	.page {
		padding-top: clamp(2.5rem, 2rem + 3vw, 5rem);
		display: grid;
		gap: 1.25rem;
	}

	h1 {
		font-size: var(--step-4);
		text-transform: uppercase;
	}

	h2 {
		font-size: var(--step-2);
		text-transform: uppercase;
	}

	.lead {
		font-size: var(--step-1);
		max-width: 65ch;
	}

	.layout {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
		gap: 1.25rem;
		align-items: start;
	}

	.steps {
		margin: 0;
		padding: 0;
		list-style: none;
		display: grid;
		gap: 1rem;
	}

	.steps li {
		display: grid;
		grid-template-columns: 2.25rem minmax(0, 1fr);
		gap: 0.9rem;
		align-items: start;
	}

	/* The first line of each step sits on the middle of its number. */
	.steps li > span:last-child {
		padding-top: 0.4rem;
	}

	.number {
		display: grid;
		place-items: center;
		width: 2.25rem;
		height: 2.25rem;
		border: 1px solid var(--border);
		border-radius: 50%;
		background: var(--surface);
		color: var(--accent);
		font: 800 var(--step-1) / 1 var(--font-display);
	}

	.panel,
	.stack {
		display: grid;
		gap: 1rem;
	}

	.ready {
		display: grid;
		gap: 0.75rem;
		justify-items: start;
	}

	.contact {
		margin: 0;
		padding-left: 1.1rem;
		display: grid;
		gap: 0.35rem;
		overflow-wrap: anywhere;
	}

	.small {
		font-size: var(--step--1);
	}

	@media (max-width: 820px) {
		.layout {
			grid-template-columns: minmax(0, 1fr);
		}
	}
</style>
