<script lang="ts">
	import { onMount, tick, untrack } from 'svelte';
	import { pushState } from '$app/navigation';
	import { page } from '$app/state';
	import { countryName, organizationCountry, shipsTo } from '@sortea/domain';
	import { CHECKOUT_DRAFT_FIELDS, clearCheckoutDraft, forgetSubmittedCheckout, markCheckoutSubmitted, readCheckoutDraft, readSubmittedCheckout, saveCheckoutDraft } from '#lib/checkout-draft.js';
	import { landingStep, stepFromState, stepOfField, stepOneErrors, stepState, type CheckoutStep } from '#lib/checkout-steps.js';
	import { documentChecks, documentField, documentFields } from '#lib/document-field.js';
	import { poolWarning } from '#lib/chances.js';
	import ChancesBadge from '#lib/components/ChancesBadge.svelte';
	import DocumentChecks from '#lib/components/DocumentChecks.svelte';
	import LegalLink from '#lib/components/legal/LegalLink.svelte';
	import { emailCheck, emailSuggestion, emailValid } from '#lib/email-check.js';
	import { money } from '#lib/format.js';
	import { countryGroups, OTHER_PROVINCE, resolveProvince, SHIPPING_ONLY_HOME, type SubdivisionOption } from '#lib/location.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const quote = $derived(data.quote);
	const site = $derived(data.site!);
	const values = $derived((form?.values ?? {}) as Record<string, string>);
	const formErrors = $derived((form?.errors ?? {}) as Record<string, string>);
	// A field's error goes away as soon as the buyer edits it; the server checks again on submit.
	let edited = $derived.by((): Record<string, true> => {
		void form;
		return {};
	});
	const serverErrors = $derived(Object.fromEntries(Object.entries(formErrors).filter(([field]) => !edited[field])));
	// What Continuar found missing in step 1 (S4), until the buyer edits each field.
	let stepErrors = $state<Record<string, string>>({});
	// One email field (S5), checked while typed; the server checks again on submit.
	let typedEmail = $state<string | undefined>(undefined);
	let leftEmail = $state(false);
	const email = $derived(typedEmail ?? values.email ?? '');
	const liveEmail = $derived(emailCheck(email, leftEmail));
	const errors: Record<string, string> = $derived({ ...serverErrors, ...stepErrors, ...(liveEmail ? { email: liveEmail } : {}) });
	const related: Record<string, string[]> = { documentType: ['documentNumber'], provinceOther: ['province'] };
	function onEdit(event: Event) {
		const name = (event.target as HTMLInputElement).name;
		if (!name) return;
		edited = { ...edited, [name]: true, ...Object.fromEntries((related[name] ?? []).map((field) => [field, true as const])) };
		if (stepErrors[name]) stepErrors = Object.fromEntries(Object.entries(stepErrors).filter(([field]) => field !== name));
		const value = (event.target as HTMLInputElement).value;
		if (name === 'province') province = value;
		if (name === 'provinceOther') provinceOther = value;
		if (name === 'city') city = value;
		if (name === 'documentType') documentType = value;
		if (name === 'documentNumber') documentNumber = value;
		if (name === 'email') typedEmail = value;
	}
	// Help at the moment for a mistyped common domain (S5): "¿Quisiste decir …?" fixes it in one tap.
	const suggestion = $derived(leftEmail ? emailSuggestion(email) : null);
	function useSuggestion() {
		if (!suggestion) return;
		fill('email', suggestion);
		formElement?.querySelector<HTMLInputElement>('#email')?.focus();
	}

	// Where the buyer lives (S6, S7): a country and a province from the reference data, or a
	// province typed by hand; the city is typed as is (2026-10-19). Without JavaScript these are plain fields.
	const groups = $derived(countryGroups(data.countries));
	let country = $derived(values.country || organizationCountry);
	let subdivisions = $derived((form?.subdivisions ?? data.subdivisions) as SubdivisionOption[]);
	let province = $derived(values.province || (values.provinceOther ? OTHER_PROVINCE : ''));
	let provinceOther = $derived(values.provinceOther ?? '');
	let city = $derived(values.city ?? '');
	// Until the page is interactive every field and step shows, so the form also works without JavaScript.
	let interactive = $state(false);
	$effect(() => {
		interactive = true;
	});
	// The number's example and format follow the selected type (S5, owner-feedback-2026-11-12).
	let documentType = $derived(values.documentType ?? 'DNI');
	const doc = $derived(documentField(documentType));
	// Checked while typed with the server's rules (S8): each requirement ticks green, and so does the field.
	let documentNumber = $derived(values.documentNumber ?? '');
	const docChecks = $derived(documentChecks(documentType, documentNumber));
	const emailOk = $derived(emailValid(email));
	const typingProvince = $derived(subdivisions.length > 0 && (!interactive || province === OTHER_PROVINCE));
	// Progressive disclosure (S1): most buyers live in the organization's country, so it shows as a
	// line with "Cambiar país"; the select opens when asked, or when the country is another one.
	let countryOpen = $state(false);
	const showCountry = $derived(!interactive || countryOpen || country !== organizationCountry || Boolean(errors.country));
	async function openCountry() {
		countryOpen = true;
		await tick();
		formElement?.querySelector<HTMLSelectElement>('#country')?.focus();
	}

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

	// Two steps in one form (S2, S4). The step lives in the history entry (shallow routing), so Back
	// and Forward move between the steps and the page, its attempt and what was typed stay as they are.
	// The page opens on the step a refused submit has to fix, or the one a restored draft was in.
	let restoredStep = $state<CheckoutStep | null>(null);
	const landing = $derived<CheckoutStep>(form && !form.closed ? landingStep({ errors: formErrors, values, refused: true }) : (restoredStep ?? 1));
	let step = $state<CheckoutStep>(1);
	$effect.pre(() => {
		const state = page.state;
		const next = landing;
		step = untrack(() => stepFromState(state, next, step));
	});
	const stepTitles: Record<CheckoutStep, string> = { 1: '¿A dónde te enviamos tu compra?', 2: 'Últimos datos' };
	let headings = $state<Partial<Record<CheckoutStep, HTMLElement>>>({});
	let stepElements = $state<Partial<Record<CheckoutStep, HTMLElement>>>({});
	let announcement = $state('');
	// What gets the focus when the step changes: its heading, a field, or nothing (a restored draft).
	let focusNext: string | null = 'heading';
	let shownStep: CheckoutStep | null = null;
	$effect(() => {
		const current = step;
		if (!interactive) return;
		if (shownStep !== null && shownStep !== current) {
			const target = focusNext;
			// The heading says the step when it gets the focus; otherwise the change is announced.
			if (target !== 'heading') announcement = `Paso ${current} de 2: ${stepTitles[current]}`;
			tick().then(() => {
				if (target === 'heading') headings[current]?.focus();
				else if (target) formElement?.querySelector<HTMLElement>(`#${target}`)?.focus();
			});
			keepDraft(current);
		}
		shownStep = current;
		focusNext = 'heading';
	});

	function stepOneValues() {
		const fields = formElement ? new FormData(formElement) : new FormData();
		const value = (name: string) => String(fields.get(name) ?? '');
		return { email: value('email'), firstName: value('firstName'), lastName: value('lastName') };
	}

	function focusField(name: string) {
		formElement?.querySelector<HTMLElement>(`#${name}`)?.focus();
	}

	// The suggestion the buyer could see when pressing Continuar: a new one stops it once, so it is read.
	let suggestionAtPress: string | null | undefined;
	let warnedSuggestion: string | null = null;
	/** Continuar (S4): always enabled; checks step 1 in place and opens step 2 when it is complete. */
	function next() {
		const seen = suggestionAtPress === undefined ? suggestion : suggestionAtPress;
		suggestionAtPress = undefined;
		leftEmail = true;
		const found = stepOneErrors(stepOneValues());
		stepErrors = found;
		const first = Object.keys(found)[0];
		if (first) return focusField(first);
		const hint = emailSuggestion(stepOneValues().email);
		if (hint && hint !== seen && hint !== warnedSuggestion) {
			warnedSuggestion = hint;
			return focusField('email');
		}
		focusNext = 'heading';
		pushState('', stepState(2));
	}

	/** Volver (S4): back to step 1 with everything kept; the step 2 entry stays for Forward. */
	function back(focus: string = 'heading') {
		focusNext = focus;
		if (step === 1) {
			focusNext = 'heading';
			return focus === 'heading' ? undefined : focusField(focus);
		}
		if ((page.state as { checkoutStep?: CheckoutStep }).checkoutStep === 2) history.back();
		else pushState('', stepState(1));
	}

	// What was typed survives an interruption (S3): kept on this device for 24 hours, never sent.
	let formElement = $state<HTMLFormElement>();
	let keeping = false;
	// After "Borrar mis datos" nothing is kept again until the buyer types.
	let erased = false;
	const keepDraft = (at: CheckoutStep = step) => {
		if (keeping && !erased && formElement && !closed) saveCheckoutDraft(localStorage, new FormData(formElement), at);
	};

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

	// "Borrar mis datos": empties the fields and this device's copy, for a shared device.
	let forgotten = $state(false);
	async function forget() {
		keeping = false;
		if (country !== organizationCountry) {
			const select = formElement?.elements.namedItem('country');
			if (select instanceof HTMLSelectElement) select.value = organizationCountry;
			await loadCountry(organizationCountry);
			await tick();
		}
		for (const name of CHECKOUT_DRAFT_FIELDS) {
			if (name === 'deliveryMethod' || name === 'country') continue;
			fill(name, name === 'documentType' ? 'DNI' : '');
		}
		await tick();
		typedEmail = '';
		leftEmail = false;
		stepErrors = {};
		edited = Object.fromEntries(Object.keys(formErrors).map((field) => [field, true as const]));
		countryOpen = false;
		clearCheckoutDraft(localStorage);
		forgotten = true;
		erased = true;
		keeping = true;
		back('email');
	}
	$effect(() => {
		// The notice goes once the buyer types again.
		if (forgotten && email) forgotten = false;
	});

	// A page whose order was already created, or whose cart was emptied, takes no more orders (2026-10-30):
	// the server says so when it renders it, and the page asks when the browser shows it again.
	type Closed = { reason: 'done' | 'empty'; reference: string | null };
	let lock = $state<Closed | null>(null);
	const closed = $derived(lock ?? form?.closed ?? data.closed);

	async function closedAttempt(attempt: string): Promise<Closed | null> {
		const response = await fetch(`/checkout/estado?intento=${encodeURIComponent(attempt)}`, { cache: 'no-store' }).catch(() => null);
		if (!response?.ok) return null;
		return ((await response.json().catch(() => ({}))) as { closed?: Closed | null }).closed ?? null;
	}

	function close(state: Closed) {
		lock = state;
		// What was typed for that order is not offered for the next one.
		clearCheckoutDraft(localStorage);
	}

	// Restored from the back/forward cache: the page is as it was when it was sent.
	async function onPageShow(event: PageTransitionEvent) {
		if (!event.persisted || !data.attempt || closed) return;
		const state = await closedAttempt(data.attempt);
		if (state) close(state);
		else submitting = false;
	}

	function onSubmit(event: SubmitEvent) {
		if (closed) {
			event.preventDefault();
			return;
		}
		if (interactive) {
			// Enter in step 1 is Continuar; a step 1 left incomplete is fixed there before paying.
			if (step === 1) {
				event.preventDefault();
				return next();
			}
			const found = stepOneErrors(stepOneValues());
			const first = Object.keys(found)[0];
			if (first) {
				event.preventDefault();
				stepErrors = found;
				return back(first);
			}
		}
		submitting = true;
		if (data.attempt) markCheckoutSubmitted(sessionStorage, data.attempt);
	}

	onMount(async () => {
		if (closed) {
			if (closed.reason === 'done') clearCheckoutDraft(localStorage);
			return;
		}
		// After a refused submit the server's copy of the form is the one shown, on the step to fix.
		if (form) {
			keeping = true;
			await tick();
			stepElements[landing]?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
			return;
		}
		// This tab sent a checkout before: if it created its order, its draft is not reused, and if this
		// is that same page shown again, it locks.
		const submitted = readSubmittedCheckout(sessionStorage);
		if (submitted) {
			const state = await closedAttempt(submitted);
			if (state && submitted === data.attempt) return close(state);
			if (state) clearCheckoutDraft(localStorage);
			forgetSubmittedCheckout(sessionStorage);
		}
		const draft = readCheckoutDraft(localStorage);
		if (!draft || !formElement) {
			keeping = true;
			return;
		}
		const { country: savedCountry, province: savedProvince, provinceOther: savedOther, ...rest } = draft.fields;
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
		const restored = landingStep({ errors: {}, values: stepOneValues(), draftStep: draft.step });
		if (restored !== step) focusNext = null;
		restoredStep = restored;
		keeping = true;
		keepDraft(restored);
	});

	// Shipping goes to the buyer's city and province, so the delivery block names them as they are typed.
	const destination = $derived({ province: resolveProvince(province, provinceOther), city: city.trim() });
	const delivery = $derived(site.delivery);
	// Home shipping stays inside the organization's country; elsewhere there is pickup (ADR 0012).
	const shipsHere = $derived(shipsTo(country));

	let method = $state('');
	$effect.pre(() => {
		if (!method) method = values.deliveryMethod ?? (quote?.requiresDelivery ? (delivery.pickupEnabled || !shipsHere ? 'pickup' : 'shipping') : 'digital');
	});
	$effect.pre(() => {
		if (!shipsHere && method === 'shipping') method = delivery.pickupEnabled ? 'pickup' : '';
	});
	const fee = $derived(method === 'shipping' ? delivery.shippingFeeMinor : 0);
	const total = $derived((quote?.subtotalMinor ?? 0) + fee);
	const givesChances = $derived((quote?.chances?.total ?? 0) > 0);
	// More chances than coupons left (S3): the refused order's reason, or what the quote already shows.
	const shortfall = $derived(form?.pool ? `${form.pool}.` : quote?.chances ? poolWarning(quote.chances) : null);
	const itemCount = $derived((quote?.lines ?? []).reduce((count, line) => count + line.quantity, 0));
	// On phones the summary is compact on top; its lines open with "Ver detalle".
	let detailOpen = $state(false);
	let submitting = $state(false);
	const stepped = $derived(interactive && !closed);
</script>

<svelte:window onpageshow={onPageShow} />

<svelte:head>
	<title>Finalizar compra | {site.organization.name}</title>
</svelte:head>

<section class="container page">
	<a class="back" href="/carrito">Volver al carrito</a>
	<h1>Finalizar compra</h1>
	<p class="muted lead">No necesitás cuenta: completás tus datos y pagás en Mercado Pago.</p>

	{#if closed}
		<div class="notice closed" role="status">
			{#if closed.reason === 'done'}
				<p class="title">Esta compra ya se procesó.</p>
				<p>Registramos el pedido y lo enviamos a Mercado Pago. Para que no se cobre dos veces, este formulario quedó cerrado.</p>
			{:else}
				<p class="title">Tu carrito está vacío.</p>
				<p>Esta página quedó desactualizada: no tiene productos para comprar.</p>
			{/if}
			<div class="actions">
				<a class="button" href="/tienda">Seguir comprando</a>
				{#if closed.reference}
					<a class="button secondary" href="/checkout/resultado?ref={encodeURIComponent(closed.reference)}">Ver el estado de tu compra</a>
				{:else if closed.reason === 'done'}
					<a class="button secondary" href="/consulta">Consultar mis compras</a>
				{/if}
			</div>
		</div>
	{/if}

	{#if quote}
		<div class="layout">
			<form method="POST" novalidate bind:this={formElement} onsubmit={onSubmit} oninput={(event) => (onEdit(event), (erased = false), keepDraft())} onchange={() => keepDraft()}>
				{#if stepped}
					<div class="progress">
						<p class="step-count" aria-hidden="true">Paso {step} de 2</p>
						<div class="bar" aria-hidden="true"><span class="done"></span><span class:done={step === 2}></span></div>
						<p class="visually-hidden" aria-live="polite">{announcement}</p>
					</div>
				{/if}
				<!-- Inside the form column, so the message never runs under the order summary. -->
				{#if form?.message}<p class="notice error" role="alert">{form.message}</p>{/if}
				{#if data.attempt}<input type="hidden" name="attempt" value={data.attempt} />{/if}

				<div class="step" data-step="1" hidden={stepped && step !== 1} bind:this={stepElements[1]}>
					<div class="step-head">
						<h2 tabindex="-1" bind:this={headings[1]}>{#if stepped}<span class="visually-hidden">Paso 1 de 2: </span>{/if}{stepTitles[1]}</h2>
						<p class="muted">Te mandamos el comprobante, tus descargas y tus cupones a este email.</p>
					</div>
					<fieldset disabled={Boolean(closed)}>
						<legend class="visually-hidden">Tu contacto</legend>
						<div class="field">
							<label for="email">Email</label>
							<input id="email" name="email" class:valid={emailOk} type="email" inputmode="email" autocomplete="email" autocapitalize="none" spellcheck="false" required defaultValue={values.email ?? ''} aria-invalid={Boolean(errors.email)} aria-describedby="email-error email-suggestion" onblur={() => (leftEmail = true)} />
							{#if errors.email}<p class="error" id="email-error">{errors.email}</p>{/if}
							<div id="email-suggestion" aria-live="polite">
								{#if suggestion && !errors.email}
									<p class="hint suggestion">¿Quisiste decir <button type="button" class="link" onclick={useSuggestion}>{suggestion}</button>?</p>
								{/if}
							</div>
						</div>
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
					</fieldset>
					{#if stepped}
						<div class="step-actions">
							<button type="button" class="button continue" onpointerdown={() => (suggestionAtPress = suggestion)} onclick={next}>Continuar</button>
						</div>
					{/if}
				</div>

				<div class="step" data-step="2" hidden={stepped && step !== 2} bind:this={stepElements[2]}>
					<div class="step-head">
						<h2 tabindex="-1" bind:this={headings[2]}>{#if stepped}<span class="visually-hidden">Paso 2 de 2: </span>{/if}{stepTitles[2]}</h2>
						<p class="muted">
							{givesChances
								? 'Con estos datos identificamos tu compra y tus chances, y te contactamos si ganás.'
								: 'Con estos datos identificamos tu compra y te contactamos si hace falta.'}
						</p>
						{#if stepped && email}
							<p class="sent-to">Te lo enviamos a <strong>{email}</strong> · <button type="button" class="link" onclick={() => back('email')}>Cambiar</button></p>
						{/if}
					</div>
					<fieldset disabled={Boolean(closed)}>
						<legend>Tus datos</legend>
						<!-- Phone, document type and number share one row on wide screens (feedback 2026-11-06). -->
						<div class="row doc">
							<div class="field">
								<label for="phone">WhatsApp / teléfono</label>
								<!-- Required since 2026-11-10 (S8): it is how the organization tells a winner. -->
								<input id="phone" name="phone" type="tel" inputmode="tel" autocomplete="tel" required defaultValue={values.phone ?? ''} aria-invalid={Boolean(errors.phone)} aria-describedby="phone-hint phone-error" />
								<p class="hint" id="phone-hint">Lo usamos para avisarte si ganás.</p>
								{#if errors.phone}<p class="error" id="phone-error">{errors.phone}</p>{/if}
							</div>
							<div class="field">
								<label for="documentType">Documento</label>
								<select id="documentType" name="documentType">
									{#each documentFields as field (field.type)}
										<option value={field.type} selected={(values.documentType ?? 'DNI') === field.type}>{field.label}</option>
									{/each}
								</select>
							</div>
							<div class="field">
								<label for="documentNumber">Número</label>
								<input id="documentNumber" class:valid={docChecks.valid} name="documentNumber" inputmode={doc.inputmode} autocapitalize={doc.autocapitalize} placeholder={doc.placeholder} autocomplete="off" required defaultValue={values.documentNumber ?? ''} aria-invalid={Boolean(errors.documentNumber)} aria-describedby="documentNumber-format documentNumber-hint documentNumber-error" />
								<DocumentChecks id="documentNumber-format" checks={docChecks.checks} />
								<p class="hint" id="documentNumber-hint">Sirve para consultar tus compras. Nunca se muestra públicamente.</p>
								{#if errors.documentNumber}<p class="error" id="documentNumber-error">{errors.documentNumber}</p>{/if}
							</div>
						</div>
					</fieldset>

					<fieldset disabled={Boolean(closed)}>
						<legend>Dónde vivís</legend>
						{#if !showCountry}
							<p class="country-line"><span>{countryName(country)}</span> · <button type="button" class="link" onclick={openCountry}>Cambiar país</button></p>
						{/if}
						<div class="field" hidden={!showCountry}>
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
								<input id="city" name="city" autocomplete="address-level2" required maxlength="80" defaultValue={values.city ?? ''} aria-invalid={Boolean(errors.city)} aria-describedby="city-error" />
								{#if errors.city}<p class="error" id="city-error">{errors.city}</p>{/if}
							</div>
						</div>
					</fieldset>

					{#if !quote.requiresDelivery}
						<!-- A digital order needs no delivery choice: what was bought goes to the email. -->
						<input type="hidden" name="deliveryMethod" value="digital" />
					{:else}
						<fieldset disabled={Boolean(closed)}>
							<legend>Entrega</legend>
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
										Completá tu provincia y ciudad: enviamos ahí.
									{/if}
								</p>
								<div class="row address">
									{@render addressField('street', 'Calle y número', 'street-address')}
									{@render addressField('postalCode', 'Código postal', 'postal-code')}
								</div>
							{/if}
						</fieldset>
					{/if}

					<fieldset disabled={Boolean(closed)}>
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
						{#if givesChances}
							<!-- S11: required for purchases that give chances, never pre-selected; the API refuses without it. -->
							<input type="hidden" name="adultDeclarationAsked" value="1" />
							<label class="check">
								<input type="checkbox" name="adultDeclaration" aria-invalid={Boolean(errors.adultDeclaration)} aria-describedby="adultDeclaration-error" />
								<span>Declaro ser mayor de 18 años. Solo las personas mayores de edad pueden recibir chances.</span>
							</label>
							{#if errors.adultDeclaration}<p class="error" id="adultDeclaration-error">{errors.adultDeclaration}</p>{/if}
							<!-- Owner feedback 2026-11-14 S3: winners are always published by name and city; there is nothing to choose. -->
							<p class="muted small">Si ganás, publicamos tu nombre, tu apellido y tu ciudad; nunca tu documento, tu domicilio, tu email ni tu teléfono.</p>
						{/if}
					</fieldset>

					<p class="privacy-note small">
						<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>
						<span>Usamos tus datos para gestionar tu compra, enviarte lo que compraste y contactarte si ganás, según las bases.</span>
					</p>

					<div class="step-actions pay-actions">
						<button class="button pay" disabled={submitting || Boolean(closed)} aria-describedby="pay-note">{submitting && !closed ? 'Preparando el pago…' : `Pagar ${money(total, quote.currency)} con Mercado Pago`}</button>
						<p class="muted small" id="pay-note">Vas a pagar en Mercado Pago con los medios que ofrece; no guardamos datos de tu tarjeta.</p>
						{#if stepped}<button type="button" class="button secondary back-step" onclick={() => back()}>Volver</button>{/if}
					</div>
				</div>

				{#if stepped}
					<p class="keep muted small">
						Guardamos lo que escribís en este dispositivo por 24 horas, para que no lo pierdas.
						<button type="button" class="link" onclick={forget}>Borrar mis datos</button>
					</p>
					{#if forgotten}<p class="ok-hint" role="status">Borramos tus datos de este dispositivo.</p>{/if}
				{/if}
			</form>

			<aside class="panel summary" aria-label="Resumen del pedido">
				<div class="summary-head">
					<h2>Tu compra</h2>
					{#if interactive}
						<button type="button" class="link detail-toggle" aria-expanded={detailOpen} aria-controls="summary-lines" onclick={() => (detailOpen = !detailOpen)}>
							{detailOpen ? 'Ocultar detalle' : 'Ver detalle'}
						</button>
					{/if}
				</div>
				<p class="count muted small">{itemCount === 1 ? '1 producto' : `${itemCount} productos`}</p>
				<ul id="summary-lines" class:collapsed={interactive && !detailOpen}>
					{#each quote.lines ?? [] as line (line.variantId)}
						{@const lineChances = quote.chances?.lines.find((entry) => entry.variantId === line.variantId)?.chances ?? 0}
						<li>
							<span>{line.name} × {line.quantity}</span><span class="money">{money(line.lineTotalMinor, quote.currency)}</span>
							{#if quote.chances && lineChances > 0}<span class="line-chances"><ChancesBadge count={lineChances} campaign={quote.chances.campaign.title} size="mini" /></span>{/if}
						</li>
					{/each}
					{#if fee > 0}<li><span>Envío</span><span class="money">{money(fee, quote.currency)}</span></li>{/if}
				</ul>
				<p class="total"><span>Total</span><span class="money">{money(total, quote.currency)}</span></p>
				{#if shortfall}
					<div class="notice error shortfall" role="alert">
						<p>{shortfall}</p>
						<a href="/carrito">Cambiar la cantidad</a>
					</div>
				{:else if quote.chances && quote.chances.total > 0}
					<div class="total-chances"><ChancesBadge count={quote.chances.total} campaign={quote.chances.campaign.title} lead="En total" size="mini" /></div>
				{/if}
				<p class="muted small note">Pagás en Mercado Pago. La compra se confirma cuando Mercado Pago nos avisa que el pago fue aprobado.</p>
			</aside>
		</div>
	{/if}
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

	.closed {
		display: grid;
		gap: 0.5rem;
		justify-items: start;
		margin-bottom: 2rem;
	}

	.closed .title {
		font: 800 var(--step-1) / 1.2 var(--font-display);
		text-transform: uppercase;
	}

	.closed .actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.75rem;
		margin-top: 0.5rem;
	}

	.layout {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 400px;
		gap: 2.5rem;
		align-items: start;
	}

	form {
		display: grid;
		gap: 1.5rem;
	}

	/* "Paso N de 2" and a bar of two segments (S2). */
	.progress {
		display: grid;
		gap: 0.5rem;
	}

	.step-count {
		font-size: var(--step--1);
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--muted);
	}

	.bar {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 0.4rem;
	}

	.bar span {
		height: 6px;
		border-radius: 999px;
		background: var(--border);
		transition: background 0.25s var(--ease-out);
	}

	.bar span.done {
		background: var(--accent);
	}

	.step {
		display: grid;
		gap: 2rem;
	}

	.step[hidden] {
		display: none;
	}

	.step-head {
		display: grid;
		gap: 0.5rem;
	}

	.step-head h2 {
		font-size: var(--step-3);
		text-transform: uppercase;
	}

	.step-head h2:focus {
		outline: none;
	}

	.sent-to {
		font-size: var(--step--1);
		overflow-wrap: anywhere;
	}

	fieldset {
		display: grid;
		gap: 1rem;
		margin: 0;
		padding: 0;
		border: 0;
		min-width: 0;
	}

	legend {
		font: 800 var(--step-1) / 1.1 var(--font-display);
		text-transform: uppercase;
		margin-bottom: 1rem;
	}

	.field[hidden] {
		display: none;
	}

	.row {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 1rem;
	}

	.row.doc {
		grid-template-columns: minmax(0, 1fr) 120px minmax(0, 1fr);
	}

	.row.address {
		grid-template-columns: 1fr 160px;
	}

	/* A text button inside a sentence: "Cambiar", "Cambiar país", "Borrar mis datos", a suggestion. */
	.link {
		padding: 0;
		border: 0;
		background: none;
		color: inherit;
		font: inherit;
		font-weight: 700;
		text-decoration: underline;
		text-decoration-color: var(--accent);
		text-underline-offset: 0.2em;
		cursor: pointer;
		overflow-wrap: anywhere;
	}

	.suggestion {
		margin-top: 0.35rem;
	}

	.country-line {
		font-weight: 600;
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

	.privacy-note {
		display: flex;
		gap: 0.6rem;
		align-items: flex-start;
		padding: 0.85rem 1rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		background: var(--surface);
		color: var(--muted);
	}

	.privacy-note svg {
		flex: none;
		color: var(--success);
		margin-top: 0.1rem;
	}

	.step-actions {
		display: grid;
		gap: 0.75rem;
		justify-items: start;
	}

	.continue,
	.pay {
		min-width: 280px;
	}

	.keep {
		padding-top: 1rem;
		border-top: 1px solid var(--border);
	}

	.summary {
		position: sticky;
		top: 90px;
		display: grid;
		gap: 1rem;
	}

	.summary-head {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: 1rem;
	}

	.summary h2 {
		font-size: var(--step-2);
		text-transform: uppercase;
	}

	/* The detail toggle is for phones; wide screens always show the lines. */
	.detail-toggle,
	.count {
		display: none;
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

	/* The chances of a line take their own row under it (S7, console polish 2026-11-11). */
	.summary li {
		flex-wrap: wrap;
		row-gap: 0.35rem;
	}

	.line-chances {
		flex-basis: 100%;
	}

	.shortfall {
		display: grid;
		gap: 0.4rem;
		margin-top: 0.75rem;
	}

	.shortfall p {
		margin: 0;
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
			gap: 1.5rem;
		}

		.lead {
			margin-bottom: 1.25rem;
		}

		/* Compact on top (S2): what is bought, the total and the chances; the lines on request. */
		.summary {
			position: static;
			order: -1;
			gap: 0.6rem;
			padding: 1rem 1.1rem;
		}

		.summary h2 {
			font-size: var(--step-1);
		}

		.detail-toggle,
		.count {
			display: block;
		}

		.summary ul.collapsed,
		.summary .note {
			display: none;
		}

		.total {
			font-size: var(--step-1);
		}

		.step-head h2 {
			font-size: var(--step-2);
		}

		.row.doc,
		.row.address,
		.options {
			grid-template-columns: 1fr;
		}

		.step-actions,
		.continue,
		.pay,
		.back-step {
			width: 100%;
			min-width: 0;
		}

		.step-actions {
			justify-items: stretch;
		}
	}

	/* Nombre and Apellido stay side by side down to small phones (S2). */
	@media (max-width: 340px) {
		.row {
			grid-template-columns: 1fr;
		}
	}
</style>
