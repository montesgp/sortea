<script lang="ts">
	import { money } from '#lib/format.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const quote = $derived(data.quote);
	const site = $derived(data.site!);
	const values = $derived((form?.values ?? {}) as Record<string, string>);
	// A field's error goes away as soon as the buyer edits it; the server checks again on submit.
	let edited = $derived.by((): Record<string, true> => {
		void form;
		return {};
	});
	const errors = $derived(Object.fromEntries(Object.entries((form?.errors ?? {}) as Record<string, string>).filter(([field]) => !edited[field])));
	const related: Record<string, string[]> = { email: ['emailConfirm'], documentType: ['documentNumber'] };
	function onEdit(event: Event) {
		const name = (event.target as HTMLInputElement).name;
		if (!name) return;
		edited = { ...edited, [name]: true, ...Object.fromEntries((related[name] ?? []).map((field) => [field, true as const])) };
	}
	const delivery = $derived(site.delivery);

	let method = $state('');
	$effect.pre(() => {
		if (!method) method = values.deliveryMethod ?? (quote.requiresDelivery ? (delivery.pickupEnabled ? 'pickup' : 'shipping') : 'digital');
	});
	const fee = $derived(method === 'shipping' ? delivery.shippingFeeMinor : 0);
	let submitting = $state(false);
</script>

<svelte:head>
	<title>Finalizar compra | {site.organization.name}</title>
</svelte:head>

<section class="container page">
	<h1>Finalizar compra</h1>
	<p class="muted lead">No necesitás cuenta. Te enviamos el comprobante y tus archivos al email que ingreses.</p>

	<div class="layout">
		<form method="POST" novalidate onsubmit={() => (submitting = true)} oninput={onEdit}>
			<!-- Inside the form column, so the message never runs under the order summary. -->
			{#if form?.message}<p class="notice error" role="alert">{form.message}</p>{/if}
			<fieldset>
				<legend>Tus datos</legend>
				<div class="row">
					<div class="field">
						<label for="firstName">Nombre</label>
						<input id="firstName" name="firstName" autocomplete="given-name" required defaultValue={values.firstName ?? ''} aria-invalid={Boolean(errors.firstName)} aria-describedby="firstName-error" />
						{#if errors.firstName}<p class="error" id="firstName-error">{errors.firstName}</p>{/if}
					</div>
					<div class="field">
						<label for="lastName">Apellido</label>
						<input id="lastName" name="lastName" autocomplete="family-name" required defaultValue={values.lastName ?? ''} aria-invalid={Boolean(errors.lastName)} aria-describedby="lastName-error" />
						{#if errors.lastName}<p class="error" id="lastName-error">{errors.lastName}</p>{/if}
					</div>
				</div>
				<div class="row doc">
					<div class="field">
						<label for="documentType">Documento</label>
						<select id="documentType" name="documentType">
							{#each [['DNI', 'DNI'], ['CUIT', 'CUIT'], ['PASSPORT', 'Pasaporte']] as [value, label] (value)}
								<option {value} selected={(values.documentType ?? 'DNI') === value}>{label}</option>
							{/each}
						</select>
					</div>
					<div class="field">
						<label for="documentNumber">Número</label>
						<input id="documentNumber" name="documentNumber" inputmode="numeric" autocomplete="off" required defaultValue={values.documentNumber ?? ''} aria-invalid={Boolean(errors.documentNumber)} aria-describedby="documentNumber-hint documentNumber-error" />
						<p class="hint" id="documentNumber-hint">Sirve para consultar tus compras. Nunca se muestra públicamente.</p>
						{#if errors.documentNumber}<p class="error" id="documentNumber-error">{errors.documentNumber}</p>{/if}
					</div>
				</div>
				<div class="row">
					<div class="field">
						<label for="email">Email</label>
						<input id="email" name="email" type="email" autocomplete="email" required defaultValue={values.email ?? ''} aria-invalid={Boolean(errors.email)} aria-describedby="email-error" />
						{#if errors.email}<p class="error" id="email-error">{errors.email}</p>{/if}
					</div>
					<div class="field">
						<label for="emailConfirm">Repetí el email</label>
						<input id="emailConfirm" name="emailConfirm" type="email" autocomplete="off" required defaultValue={values.emailConfirm ?? ''} aria-invalid={Boolean(errors.emailConfirm)} aria-describedby="emailConfirm-error" />
						{#if errors.emailConfirm}<p class="error" id="emailConfirm-error">{errors.emailConfirm}</p>{/if}
					</div>
				</div>
				<div class="field">
					<label for="phone">Teléfono <span class="muted">(opcional)</span></label>
					<input id="phone" name="phone" type="tel" autocomplete="tel" defaultValue={values.phone ?? ''} aria-invalid={Boolean(errors.phone)} />
					{#if errors.phone}<p class="error">{errors.phone}</p>{/if}
				</div>
			</fieldset>

			<fieldset>
				<legend>Entrega</legend>
				{#if !quote.requiresDelivery}
					<input type="hidden" name="deliveryMethod" value="digital" />
					<p class="muted">Tu pedido es digital: lo recibís por email apenas se confirma el pago.</p>
				{:else}
					<div class="options">
						{#if delivery.pickupEnabled}
							<label class="check option">
								<input type="radio" name="deliveryMethod" value="pickup" bind:group={method} />
								<span><strong>Retiro sin cargo</strong><br /><span class="muted">{delivery.pickupNote ?? 'Coordinamos el retiro por email.'}</span></span>
							</label>
						{/if}
						{#if delivery.shippingEnabled}
							<label class="check option">
								<input type="radio" name="deliveryMethod" value="shipping" bind:group={method} />
								<span><strong>Envío a domicilio</strong><br /><span class="muted">{money(delivery.shippingFeeMinor, quote.currency)}</span></span>
							</label>
						{/if}
					</div>
					{#if method === 'shipping'}
						<div class="field">
							<label for="street">Calle y número</label>
							<input id="street" name="street" autocomplete="street-address" defaultValue={values.street ?? ''} aria-invalid={Boolean(errors.street)} />
							{#if errors.street}<p class="error">{errors.street}</p>{/if}
						</div>
						<div class="row three">
							<div class="field">
								<label for="city">Localidad</label>
								<input id="city" name="city" autocomplete="address-level2" defaultValue={values.city ?? ''} aria-invalid={Boolean(errors.city)} />
							</div>
							<div class="field">
								<label for="province">Provincia</label>
								<input id="province" name="province" autocomplete="address-level1" defaultValue={values.province ?? ''} aria-invalid={Boolean(errors.province)} />
							</div>
							<div class="field">
								<label for="postalCode">Código postal</label>
								<input id="postalCode" name="postalCode" autocomplete="postal-code" defaultValue={values.postalCode ?? ''} aria-invalid={Boolean(errors.postalCode)} />
							</div>
						</div>
					{/if}
				{/if}
			</fieldset>

			<fieldset>
				<legend>Consentimientos</legend>
				<label class="check">
					<input type="checkbox" name="terms" aria-invalid={Boolean(errors.terms)} />
					<span>Acepto los <a href="/legales/terminos" target="_blank">términos y condiciones de venta</a>.</span>
				</label>
				{#if errors.terms}<p class="error">{errors.terms}</p>{/if}
				<label class="check">
					<input type="checkbox" name="privacy" aria-invalid={Boolean(errors.privacy)} />
					<span>Leí la <a href="/legales/privacidad" target="_blank">política de privacidad</a> y entiendo cómo se usan mis datos para esta compra.</span>
				</label>
				{#if errors.privacy}<p class="error">{errors.privacy}</p>{/if}
				<label class="check">
					<input type="checkbox" name="marketingEmail" defaultChecked={values.marketingEmail === 'on'} />
					<span>Quiero recibir novedades por email. <span class="muted">Opcional, podés darte de baja cuando quieras.</span></span>
				</label>
			</fieldset>

			<button class="button pay" disabled={submitting}>{submitting ? 'Preparando el pago…' : 'Ir a pagar con Mercado Pago'}</button>
		</form>

		<aside class="panel summary" aria-label="Resumen del pedido">
			<h2>Tu pedido</h2>
			<ul>
				{#each quote.lines ?? [] as line (line.variantId)}
					<li><span>{line.name} × {line.quantity}</span><span class="money">{money(line.lineTotalMinor, quote.currency)}</span></li>
				{/each}
				{#if fee > 0}<li><span>Envío</span><span class="money">{money(fee, quote.currency)}</span></li>{/if}
			</ul>
			<p class="total"><span>Total</span><span class="money">{money((quote.subtotalMinor ?? 0) + fee, quote.currency)}</span></p>
			<p class="muted small">Pagás en Mercado Pago. La compra se confirma cuando Mercado Pago nos avisa que el pago fue aprobado.</p>
		</aside>
	</div>
</section>

<style>
	.page {
		padding-top: clamp(2.5rem, 2rem + 3vw, 5rem);
	}

	h1 {
		font-size: var(--step-4);
		text-transform: uppercase;
	}

	.lead {
		margin: 0.75rem 0 2rem;
	}

	.layout {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 400px;
		gap: 2.5rem;
		align-items: start;
	}

	form {
		display: grid;
		gap: 2rem;
	}

	fieldset {
		display: grid;
		gap: 1rem;
		margin: 0;
		padding: 0;
		border: 0;
	}

	legend {
		font: 800 var(--step-2) / 1.1 var(--font-display);
		text-transform: uppercase;
		margin-bottom: 1rem;
	}

	.row {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 1rem;
	}

	.row.doc {
		grid-template-columns: 160px 1fr;
	}

	.row.three {
		grid-template-columns: 1fr 1fr 160px;
	}

	.options {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 0.75rem;
	}

	.option {
		padding: 1rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		background: var(--surface);
	}

	.option:has(input:checked) {
		border-color: var(--accent);
	}

	.error {
		color: var(--danger);
		font-size: var(--step--1);
	}

	.pay {
		justify-self: start;
		min-width: 280px;
	}

	.summary {
		position: sticky;
		top: 90px;
		display: grid;
		gap: 1rem;
	}

	.summary h2 {
		font-size: var(--step-2);
		text-transform: uppercase;
	}

	.summary ul {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 0.6rem;
	}

	.summary li,
	.total {
		display: flex;
		justify-content: space-between;
		gap: 1rem;
	}

	.total {
		padding-top: 0.75rem;
		border-top: 1px solid var(--border);
		font: 800 var(--step-2) / 1 var(--font-display);
	}

	.small {
		font-size: var(--step--1);
	}

	@media (max-width: 900px) {
		.layout {
			grid-template-columns: 1fr;
		}

		.summary {
			position: static;
			order: -1;
		}

		.row,
		.row.doc,
		.row.three,
		.options {
			grid-template-columns: 1fr;
		}
	}
</style>
