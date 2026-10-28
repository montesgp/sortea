<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { organizationCountry, shipsTo } from '@sortea/domain';
	import { readCheckoutDraft, saveCheckoutDraft } from '#lib/checkout-draft.js';
	import LegalLink from '#lib/components/legal/LegalLink.svelte';
	import { emailCheck } from '#lib/email-check.js';
	import { money } from '#lib/format.js';
	import { countryGroups, OTHER_PROVINCE, resolveProvince, SHIPPING_ONLY_HOME, type SubdivisionOption } from '#lib/location.js';
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
	const serverErrors = $derived(Object.fromEntries(Object.entries((form?.errors ?? {}) as Record<string, string>).filter(([field]) => !edited[field])));
	// The email pair is also checked while typed (S5); the server checks again on submit.
	let typedEmail = $state<{ email?: string; emailConfirm?: string }>({});
	let left = $state({ email: false, confirm: false });
	const live = $derived(emailCheck(typedEmail.email ?? values.email ?? '', typedEmail.emailConfirm ?? values.emailConfirm ?? '', left));
	const errors: Record<string, string> = $derived({ ...serverErrors, ...(live.email ? { email: live.email } : {}), ...(live.emailConfirm ? { emailConfirm: live.emailConfirm } : {}) });
	const related: Record<string, string[]> = { email: ['emailConfirm'], documentType: ['documentNumber'], provinceOther: ['province'] };
	function onEdit(event: Event) {
		const name = (event.target as HTMLInputElement).name;
		if (!name) return;
		edited = { ...edited, [name]: true, ...Object.fromEntries((related[name] ?? []).map((field) => [field, true as const])) };
		const value = (event.target as HTMLInputElement).value;
		if (name === 'province') province = value;
		if (name === 'provinceOther') provinceOther = value;
		if (name === 'city') city = value;
		if (name === 'email' || name === 'emailConfirm') typedEmail = { ...typedEmail, [name]: value };
	}

	// Where the buyer lives (S6, S7): a country and a province from the reference data, or a
	// province typed by hand; the city is typed as is (2026-10-19). Without JavaScript these are plain fields.
	const groups = $derived(countryGroups(data.countries));
	let country = $derived(values.country || organizationCountry);
	let subdivisions = $derived((form?.subdivisions ?? data.subdivisions) as SubdivisionOption[]);
	let province = $derived(values.province || (values.provinceOther ? OTHER_PROVINCE : ''));
	let provinceOther = $derived(values.provinceOther ?? '');
	let city = $derived(values.city ?? '');
	// Until the page is interactive the "not in the list" field stays visible, so it also works without JavaScript.
	let interactive = $state(false);
	$effect(() => {
		interactive = true;
	});
	const typingProvince = $derived(subdivisions.length > 0 && (!interactive || province === OTHER_PROVINCE));

	let countryRequest = 0;
	async function loadCountry(code: string) {
		country = code;
		province = '';
		provinceOther = '';
		const request = ++countryRequest;
		const response = await fetch(`/ubicaciones/provincias?pais=${encodeURIComponent(code)}`).catch(() => null);
		const body = response?.ok ? ((await response.json()) as { subdivisions: SubdivisionOption[] }) : { subdivisions: [] };
		if (request === countryRequest) subdivisions = body.subdivisions;
	}
	const changeCountry = (event: Event) => loadCountry((event.target as HTMLSelectElement).value);

	// What was typed survives a trip back to the cart (2026-10-19): kept in this tab only, never sent.
	let formElement = $state<HTMLFormElement>();
	const keepDraft = () => formElement && saveCheckoutDraft(sessionStorage, new FormData(formElement));

	function fill(name: string, value: string) {
		const field = formElement?.elements.namedItem(name);
		if (!field) return;
		if (field instanceof RadioNodeList) {
			for (const radio of field) if (radio instanceof HTMLInputElement && radio.value === value && !radio.disabled) radio.click();
			return;
		}
		if (!(field instanceof HTMLInputElement || field instanceof HTMLSelectElement) || field.type === 'hidden') return;
		field.value = value;
		field.dispatchEvent(new Event('input', { bubbles: true }));
	}

	onMount(async () => {
		// After a refused submit the server's copy of the form is the one shown.
		if (form) return;
		const draft = readCheckoutDraft(sessionStorage);
		if (!draft || !formElement) return;
		const { country: savedCountry, province: savedProvince, provinceOther: savedOther, ...rest } = draft;
		if (savedCountry && savedCountry !== country) {
			const select = formElement.elements.namedItem('country');
			if (select instanceof HTMLSelectElement) select.value = savedCountry;
			await loadCountry(savedCountry);
			await tick();
		}
		if (savedProvince) fill('province', savedProvince);
		await tick();
		if (savedOther) fill('provinceOther', savedOther);
		for (const [name, value] of Object.entries(rest)) if (value) fill(name, value);
		await tick();
		keepDraft();
	});

	// Shipping goes to the buyer's city and province, so the delivery block names them as they are typed.
	const destination = $derived({ province: resolveProvince(province, provinceOther), city: city.trim() });
	const delivery = $derived(site.delivery);
	// Home shipping stays inside the organization's country; elsewhere there is pickup (ADR 0012).
	const shipsHere = $derived(shipsTo(country));

	let method = $state('');
	$effect.pre(() => {
		if (!method) method = values.deliveryMethod ?? (quote.requiresDelivery ? (delivery.pickupEnabled || !shipsHere ? 'pickup' : 'shipping') : 'digital');
	});
	$effect.pre(() => {
		if (!shipsHere && method === 'shipping') method = delivery.pickupEnabled ? 'pickup' : '';
	});
	const fee = $derived(method === 'shipping' ? delivery.shippingFeeMinor : 0);
	let submitting = $state(false);
</script>

<svelte:head>
	<title>Finalizar compra | {site.organization.name}</title>
</svelte:head>

<section class="container page">
	<a class="back" href="/carrito">Volver al carrito</a>
	<h1>Finalizar compra</h1>
	<p class="muted lead">No necesitás cuenta. Te enviamos el comprobante y tus archivos al email que ingreses.</p>

	<div class="layout">
		<form method="POST" novalidate bind:this={formElement} onsubmit={() => (submitting = true)} oninput={(event) => (onEdit(event), keepDraft())} onchange={keepDraft}>
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
						<input id="email" name="email" type="email" autocomplete="email" required defaultValue={values.email ?? ''} aria-invalid={Boolean(errors.email)} aria-describedby="email-error" onblur={() => (left.email = true)} />
						{#if errors.email}<p class="error" id="email-error">{errors.email}</p>{/if}
					</div>
					<div class="field">
						<label for="emailConfirm">Repetí el email</label>
						<input id="emailConfirm" name="emailConfirm" type="email" autocomplete="off" required defaultValue={values.emailConfirm ?? ''} aria-invalid={Boolean(errors.emailConfirm)} aria-describedby="emailConfirm-error" onblur={() => (left.confirm = true)} />
						{#if errors.emailConfirm}<p class="error" id="emailConfirm-error">{errors.emailConfirm}</p>{:else if live.matches}<p class="ok-hint" id="emailConfirm-error">Los emails coinciden</p>{/if}
					</div>
				</div>
				<div class="field">
					<label for="phone">Teléfono <span class="muted">(opcional)</span></label>
					<input id="phone" name="phone" type="tel" autocomplete="tel" defaultValue={values.phone ?? ''} aria-invalid={Boolean(errors.phone)} />
					{#if errors.phone}<p class="error">{errors.phone}</p>{/if}
				</div>
				<div class="field">
					<label for="country">País</label>
					<select id="country" name="country" autocomplete="country" onchange={changeCountry} aria-invalid={Boolean(errors.country)} aria-describedby="country-error">
						{#each groups as group (group.label)}
							<optgroup label={group.label}>
								{#each group.countries as option (option.code)}
									<option value={option.code} selected={option.code === country}>{option.name}</option>
								{/each}
							</optgroup>
						{/each}
					</select>
					{#if errors.country}<p class="error" id="country-error">{errors.country}</p>{/if}
				</div>
				<div class="row">
					<div class="field">
						<label for="province">Provincia</label>
						{#if subdivisions.length > 0}
							<select id="province" name="province" autocomplete="address-level1" required aria-invalid={Boolean(errors.province)} aria-describedby="province-error">
								<option value="" selected={!province}>Seleccioná una provincia</option>
								{#each subdivisions as subdivision (subdivision.code)}
									<option value={subdivision.name} selected={province === subdivision.name}>{subdivision.name}</option>
								{/each}
								<option value={OTHER_PROVINCE} selected={province === OTHER_PROVINCE}>Otra (la escribo)</option>
							</select>
						{:else}
							<input id="province" name="province" autocomplete="address-level1" required maxlength="80" defaultValue={province === OTHER_PROVINCE ? '' : province} aria-invalid={Boolean(errors.province)} aria-describedby="province-error" />
						{/if}
						{#if errors.province}<p class="error" id="province-error">{errors.province}</p>{/if}
						{#if typingProvince}
							<label class="other" for="provinceOther">Tu provincia, si no está en la lista</label>
							<input id="provinceOther" name="provinceOther" maxlength="80" defaultValue={provinceOther} />
						{/if}
					</div>
					<div class="field">
						<label for="city">Ciudad</label>
						<input
							id="city"
							name="city"
							autocomplete="address-level2"
							required
							maxlength="80"
							defaultValue={values.city ?? ''}
							aria-invalid={Boolean(errors.city)}
							aria-describedby="city-error"
						/>
						{#if errors.city}<p class="error" id="city-error">{errors.city}</p>{/if}
					</div>
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
							<label class="check option" class:unavailable={!shipsHere}>
								<input type="radio" name="deliveryMethod" value="shipping" bind:group={method} disabled={!shipsHere} aria-describedby={shipsHere ? undefined : 'shipping-country'} />
								<span><strong>Envío a domicilio</strong><br /><span class="muted">{money(delivery.shippingFeeMinor, quote.currency)}</span></span>
							</label>
						{/if}
					</div>
					{#if delivery.shippingEnabled && !shipsHere}
						<p class="muted" id="shipping-country">{SHIPPING_ONLY_HOME}.{delivery.pickupEnabled ? ' Podés retirar tu pedido.' : ''}</p>
					{/if}
					{#if method === 'shipping'}
						{#snippet addressField(name: string, label: string, autocomplete: AutoFill)}
							<div class="field">
								<label for={name}>{label}</label>
								<input id={name} {name} {autocomplete} defaultValue={values[name] ?? ''} aria-invalid={Boolean(errors[name])} aria-describedby="{name}-error" />
								{#if errors[name]}<p class="error" id="{name}-error">{errors[name]}</p>{/if}
							</div>
						{/snippet}
						<p class="muted destination">
							{#if destination.province && destination.city}
								Enviamos a <strong>{destination.city}, {destination.province}</strong>.
							{:else}
								Completá tu provincia y ciudad en Tus datos: enviamos ahí.
							{/if}
						</p>
						<div class="row address">
							{@render addressField('street', 'Calle y número', 'street-address')}
							{@render addressField('postalCode', 'Código postal', 'postal-code')}
						</div>
					{/if}
				{/if}
			</fieldset>

			<fieldset>
				<legend>Consentimientos</legend>
				<label class="check">
					<input type="checkbox" name="terms" aria-invalid={Boolean(errors.terms)} />
					<span>Acepto los <LegalLink href="/legales/terminos">términos y condiciones de venta</LegalLink>.</span>
				</label>
				{#if errors.terms}<p class="error">{errors.terms}</p>{/if}
				<label class="check">
					<input type="checkbox" name="privacy" aria-invalid={Boolean(errors.privacy)} />
					<span>Leí la <LegalLink href="/legales/privacidad">política de privacidad</LegalLink> y entiendo cómo se usan mis datos para esta compra.</span>
				</label>
				{#if errors.privacy}<p class="error">{errors.privacy}</p>{/if}
				{#if (quote.chances?.total ?? 0) > 0}
					<!-- S5: optional and never pre-selected; it only applies to purchases that give chances. -->
					<label class="check">
						<input type="checkbox" name="winnerPublicity" />
						<span>Opcional: si gano, acepto que se publique mi nombre, mi ciudad y la cantidad de chances que compré. Si no lo marcás, publicamos solo el cupón ganador.</span>
					</label>
				{/if}
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
	.ok-hint {
		font-size: var(--step--1);
		color: var(--success);
	}

	.page {
		padding-top: clamp(2.5rem, 2rem + 3vw, 5rem);
	}

	.back {
		display: inline-block;
		margin-bottom: 1rem;
		font-size: var(--step--1);
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

	.row.address {
		grid-template-columns: 1fr 160px;
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

	.option.unavailable {
		opacity: 0.55;
	}

	.other {
		margin-top: 0.5rem;
		font-size: var(--step--1);
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
		.row.address,
		.options {
			grid-template-columns: 1fr;
		}
	}
</style>
