<script lang="ts">
	import DateField from '#lib/components/DateField.svelte';
	import TextArea from '#lib/components/TextArea.svelte';
	import type { NewCampaignField } from '#lib/campaign-form.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const values = $derived(form?.values);
	const errors = $derived((form?.errors ?? {}) as Partial<Record<NewCampaignField, string>>);
	const value = (field: Exclude<keyof NonNullable<typeof values>, 'chances'>, fallback = '') => values?.[field] ?? fallback;
	const described = (field: NewCampaignField, hint?: string) => (errors[field] ? `${field}-error` : hint);
</script>

<svelte:head>
	<title>Nueva campaña | Panel</title>
</svelte:head>

{#snippet fieldError(field: NewCampaignField)}
	{#if errors[field]}<p class="error" id="{field}-error">{errors[field]}</p>{/if}
{/snippet}

<a class="small" href="/admin/campanas">Volver a campañas</a>
<h1>Nueva campaña</h1>
<p class="muted small">
	Se crea como borrador: no se publica ni recibe participaciones. Las fechas pueden quedar a definir. Después, en la página de la campaña, cargás los premios,
	revisás las bases y las chances, y registrás las aprobaciones. Sin las aprobaciones legales y del medio de pago la campaña no puede abrir.
</p>

{#if form?.message}<p class="notice error" role="alert">{form.message}</p>{/if}

<form method="POST" class="stack">
	<section class="panel" aria-labelledby="content-title">
		<h2 id="content-title">Contenido</h2>
		<div class="row">
			<div class="field">
				<label for="title">Título</label>
				<input id="title" name="title" required minlength="3" maxlength="120" placeholder="Honda Wave 0 km" defaultValue={value('title')} aria-invalid={Boolean(errors.title)} aria-describedby={described('title')} />
				{@render fieldError('title')}
			</div>
			<div class="field">
				<label for="slug">Dirección pública</label>
				<input
					id="slug"
					name="slug"
					required
					pattern="[a-z0-9]+(-[a-z0-9]+)*"
					maxlength="60"
					placeholder="honda-wave"
					defaultValue={value('slug')}
					aria-invalid={Boolean(errors.slug)}
					aria-describedby={described('slug', 'slug-hint')}
				/>
				{#if errors.slug}{@render fieldError('slug')}{:else}<p class="hint" id="slug-hint">Queda en /sorteos/… Minúsculas, números y guiones.</p>{/if}
			</div>
		</div>
		<div class="field">
			<label for="subtitle">Bajada <span class="muted">(opcional)</span></label>
			<input id="subtitle" name="subtitle" maxlength="120" defaultValue={value('subtitle')} aria-invalid={Boolean(errors.subtitle)} aria-describedby={described('subtitle')} />
			{@render fieldError('subtitle')}
		</div>
		<div class="field">
			<label for="summary">Resumen</label>
			<TextArea id="summary" name="summary" rows={3} required minlength={10} maxlength={1200} value={value('summary')} aria-invalid={Boolean(errors.summary)} aria-describedby={described('summary')} />
			{@render fieldError('summary')}
		</div>
	</section>

	<section class="panel" aria-labelledby="dates-title">
		<h2 id="dates-title">Fechas</h2>
		<p class="muted small">Si todavía no las sabés, dejalas vacías: la campaña queda como «Borrador · fechas a definir» y no se puede publicar ni abrir hasta cargarlas.</p>
		<div class="field">
			<label for="timezone">Zona horaria</label>
			<select id="timezone" name="timezone" aria-invalid={Boolean(errors.timezone)} aria-describedby={described('timezone')}>
				{#each data.timeZones as zone (zone)}
					<option value={zone} selected={zone === value('timezone', data.session.organization.timezone)}>{zone}</option>
				{/each}
			</select>
			{@render fieldError('timezone')}
		</div>
		<div class="row three">
			<div class="field">
				<label for="opensAt">Apertura <span class="muted">(opcional)</span></label>
				<DateField id="opensAt" name="opensAt" timeLabel="Hora de apertura" date={value('opensAt')} time={value('opensAtTime')} invalid={Boolean(errors.opensAt)} describedby={described('opensAt')} />
				{@render fieldError('opensAt')}
			</div>
			<div class="field">
				<label for="closesAt">Cierre <span class="muted">(opcional)</span></label>
				<DateField id="closesAt" name="closesAt" timeLabel="Hora de cierre" date={value('closesAt')} time={value('closesAtTime')} invalid={Boolean(errors.closesAt)} describedby={described('closesAt')} />
				{@render fieldError('closesAt')}
			</div>
			<div class="field">
				<label for="drawAt">Sorteo o transmisión <span class="muted">(opcional)</span></label>
				<DateField id="drawAt" name="drawAt" timeLabel="Hora del sorteo o la transmisión" date={value('drawAt')} time={value('drawAtTime')} invalid={Boolean(errors.drawAt)} describedby={described('drawAt')} />
				{@render fieldError('drawAt')}
			</div>
		</div>
	</section>

	<section class="panel" aria-labelledby="chances-title">
		<h2 id="chances-title">Productos que dan chances</h2>
		<p class="muted small">Chances por unidad comprada de cada producto, para todas sus variantes; 0 si no participa. Se pueden cambiar hasta que la campaña abra.</p>
		{@render fieldError('chancesPerProduct')}
		{#if data.products.length}
			<div class="chances">
				{#each data.products as product (product.id)}
					<div class="field">
						<label for="chances-{product.id}">{product.name}{#if product.status === 'draft'} <span class="muted">(borrador)</span>{/if}</label>
						<input
							id="chances-{product.id}"
							name="chances.{product.id}"
							type="number"
							min="0"
							max="100"
							step="1"
							inputmode="numeric"
							defaultValue={values?.chances?.[product.id] ?? '0'}
							aria-describedby={errors.chancesPerProduct ? 'chancesPerProduct-error' : undefined}
						/>
					</div>
				{/each}
			</div>
		{:else}
			<p class="muted small">Todavía no hay productos. Podés cargar las chances después, en la página de la campaña.</p>
		{/if}
	</section>

	<section class="panel" aria-labelledby="rules-title">
		<h2 id="rules-title">Bases y requisitos</h2>
		<div class="row">
			<div class="field">
				<label for="minAge">Edad mínima</label>
				<input id="minAge" name="minAge" type="number" min="16" max="99" step="1" required defaultValue={value('minAge', '18')} aria-invalid={Boolean(errors.minAge)} aria-describedby={described('minAge')} />
				{@render fieldError('minAge')}
			</div>
			<div class="field">
				<label for="residency">Residencia</label>
				<input id="residency" name="residency" required maxlength="120" defaultValue={value('residency', 'República Argentina')} aria-invalid={Boolean(errors.residency)} aria-describedby={described('residency')} />
				{@render fieldError('residency')}
			</div>
		</div>
		<div class="field">
			<label for="rulesMarkdown">Texto inicial de las bases</label>
			<TextArea
				id="rulesMarkdown"
				name="rulesMarkdown"
				rows={10}
				required
				minlength={20}
				value={value('rulesMarkdown')}
				aria-invalid={Boolean(errors.rulesMarkdown)}
				aria-describedby={described('rulesMarkdown', 'rules-hint')}
			/>
			{#if errors.rulesMarkdown}{@render fieldError('rulesMarkdown')}{:else}<p class="hint" id="rules-hint">En Markdown. Queda como versión 1 en borrador; se bloquea al abrir la campaña.</p>{/if}
		</div>
	</section>

	<section class="panel" aria-labelledby="seo-title">
		<h2 id="seo-title">Buscadores y vista previa <span class="muted small">(opcional)</span></h2>
		<div class="row">
			<div class="field">
				<label for="seoTitle">Título para buscadores</label>
				<input id="seoTitle" name="seoTitle" maxlength="70" defaultValue={value('seoTitle')} aria-invalid={Boolean(errors.seoTitle)} aria-describedby={described('seoTitle')} />
				{@render fieldError('seoTitle')}
			</div>
			<div class="field">
				<label for="seoDescription">Descripción para buscadores</label>
				<input id="seoDescription" name="seoDescription" maxlength="200" defaultValue={value('seoDescription')} aria-invalid={Boolean(errors.seoDescription)} aria-describedby={described('seoDescription')} />
				{@render fieldError('seoDescription')}
			</div>
		</div>
	</section>

	<div><button class="button">Crear borrador</button></div>
</form>

<style>
	h1 {
		font-size: var(--step-4);
		text-transform: uppercase;
		margin-block: 0.5rem;
	}

	h2 {
		font-size: var(--step-1);
		text-transform: uppercase;
	}

	.small {
		font-size: var(--step--1);
	}

	.panel,
	.stack {
		display: grid;
		gap: 0.9rem;
	}

	.stack {
		margin-top: 1rem;
	}

	.row,
	.chances {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
		gap: 0.9rem;
	}
</style>
