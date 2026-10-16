<script lang="ts">
	import TextArea from '#lib/components/TextArea.svelte';
	import { page } from '$app/state';
	import type { CmsBlockKey } from '@sortea/domain';
	import { editableGalleryRows, editableRows, type GalleryRow, type Row } from '#lib/cms-form.js';
	import { dateTime } from '#lib/format.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const timezone = $derived(data.session.organization.timezone);

	const tabs = [
		{ id: 'marca', label: 'Marca' },
		{ id: 'inicio', label: 'Inicio' },
		{ id: 'seo', label: 'Buscadores y redes' },
		{ id: 'aviso', label: 'Aviso' },
		{ id: 'restauraciones', label: 'Restauraciones' },
		{ id: 'legales', label: 'Legales' },
		{ id: 'preguntas', label: 'Preguntas frecuentes' },
		{ id: 'imagenes', label: 'Imágenes' }
	] as const;
	const tab = $derived(tabs.find((candidate) => candidate.id === page.url.searchParams.get('tab'))?.id ?? 'marca');

	const block = (key: CmsBlockKey) => data.blocks.find((candidate) => candidate.key === key)!;
	const feedback = (target: string) => (form?.target === target ? form : null);
	/** What the form shows: a rejected submission, then the draft, then what is published. */
	function values(key: CmsBlockKey): Record<string, unknown> {
		const rejected = feedback(key);
		if (rejected && !rejected.ok && 'content' in rejected && rejected.content) return rejected.content as Record<string, unknown>;
		const current = block(key);
		return current.draft ?? current.published ?? {};
	}
	const str = (value: unknown) => (typeof value === 'string' ? value : '');
	const mediaUrl = (ref: string) => data.media.find((media) => media.ref === ref)?.url ?? null;
	const preview = (value: string) => (value.startsWith('media:') ? mediaUrl(value) : value.startsWith('/') || value.startsWith('https://') ? value : null);
	const kb = (bytes: number) => `${Math.max(1, Math.round(bytes / 1024))} KB`;
</script>

<svelte:head>
	<title>Sitio | Panel</title>
</svelte:head>

{#snippet message(target: string)}
	{@const result = feedback(target)}
	{#if result}<p class="notice {result.ok ? 'ok' : 'error'}" role={result.ok ? 'status' : 'alert'}>{result.message}</p>{/if}
{/snippet}

{#snippet status(key: CmsBlockKey)}
	{@const current = block(key)}
	<p class="status">
		{#if current.published}
			<span class="chip ok">Publicado · versión {current.version}</span>
			<span class="muted small">{dateTime(current.publishedAt!, timezone, 'short')}</span>
		{:else}
			<span class="chip neutral">Sin publicar</span>
		{/if}
		{#if current.draft}<span class="chip warn">Borrador sin publicar</span>{/if}
	</p>
{/snippet}

{#snippet textField(name: string, label: string, value: unknown, options: { required?: boolean; max?: number; hint?: string; placeholder?: string; type?: string } = {})}
	<div class="field">
		<label for={name}>{label}</label>
		<input id={name} {name} type={options.type ?? 'text'} required={options.required} maxlength={options.max} placeholder={options.placeholder} defaultValue={str(value)} />
		{#if options.hint}<span class="hint">{options.hint}</span>{/if}
	</div>
{/snippet}

{#snippet areaField(name: string, label: string, value: unknown, options: { required?: boolean; max?: number; rows?: number } = {})}
	<div class="field">
		<label for={name}>{label}</label>
		<TextArea id={name} {name} rows={options.rows ?? 3} required={options.required} maxlength={options.max} value={str(value)} />
	</div>
{/snippet}

{#snippet imageField(name: string, label: string, value: unknown)}
	{@const current = str(value)}
	{@const url = current ? preview(current) : null}
	<div class="field">
		<label for={name}>{label}</label>
		<select id={name} {name}>
			<option value="">Sin imagen</option>
			{#if current && !current.startsWith('media:')}<option value={current} selected>Actual: {current}</option>{/if}
			{#each data.media as media (media.id)}
				<option value={media.ref} selected={media.ref === current}>{media.filename}</option>
			{/each}
		</select>
		{#if url}<img class="thumb" src={url} alt="" />{/if}
		<span class="hint">Subí imágenes nuevas en la pestaña <a href="?tab=imagenes">Imágenes</a>.</span>
	</div>
{/snippet}

{#snippet photoRow(row: GalleryRow, index: number)}
	{@const id = `items-${index}`}
	{@const name = (field: string) => `items.${index}.${field}`}
	{@const url = row.image ? preview(row.image) : null}
	{@const n = index + 1}
	<fieldset class="rows photo">
		<legend>Foto {n}</legend>
		<div class="row">
			<div class="field">
				<label for="{id}-image">Imagen {n}</label>
				<select id="{id}-image" name={name('image')}>
					<option value="">Sin imagen</option>
					{#if row.image && !row.image.startsWith('media:')}<option value={row.image} selected>Actual: {row.image}</option>{/if}
					{#each data.media as media (media.id)}
						<option value={media.ref} selected={media.ref === row.image}>{media.filename}</option>
					{/each}
				</select>
				{#if url}<img class="thumb" src={url} alt="" />{/if}
			</div>
			<div class="field">
				<label for="{id}-alt">Descripción {n}</label>
				<input id="{id}-alt" name={name('alt')} maxlength={200} defaultValue={row.alt} />
				<span class="hint">Qué se ve en la foto, para quien no puede verla.</span>
			</div>
		</div>
		<div class="row-item">
			<div class="field">
				<label for="{id}-title">Título {n}</label>
				<input id="{id}-title" name={name('title')} maxlength={80} defaultValue={row.title} />
			</div>
			<div class="field">
				<label for="{id}-body">Texto {n}</label>
				<TextArea id="{id}-body" name={name('body')} rows={2} maxlength={400} value={str(row.body)} />
			</div>
		</div>
		<div class="row">
			<div class="field">
				<label for="{id}-author">Autor {n}</label>
				<input id="{id}-author" name={name('author')} maxlength={160} defaultValue={str(row.credit?.author)} />
			</div>
			<div class="field">
				<label for="{id}-license">Licencia {n}</label>
				<input id="{id}-license" name={name('license')} maxlength={60} placeholder="CC BY-SA 4.0" defaultValue={str(row.credit?.license)} />
			</div>
			<div class="field">
				<label for="{id}-source">Fuente {n}</label>
				<input id="{id}-source" name={name('sourceUrl')} type="url" placeholder="https://commons.wikimedia.org/wiki/File:…" defaultValue={str(row.credit?.sourceUrl)} />
			</div>
		</div>
	</fieldset>
{/snippet}

{#snippet rowsField(prefix: string, label: string, existing: unknown, max: number, bodyRows = 2, bodyMax = 400)}
	<fieldset class="rows">
		<legend>{label}</legend>
		<p class="hint">Hasta {max}. Dejá una fila vacía para quitarla.</p>
		{#each editableRows(existing as Row[] | undefined, max) as row, index (index)}
			<div class="row-item">
				<div class="field">
					<label for="{prefix}-{index}-title">Título {index + 1}</label>
					<input id="{prefix}-{index}-title" name="{prefix}.{index}.title" maxlength={120} defaultValue={row.title} />
				</div>
				<div class="field">
					<label for="{prefix}-{index}-body">Texto {index + 1}</label>
					<TextArea id="{prefix}-{index}-body" name="{prefix}.{index}.body" rows={bodyRows} maxlength={bodyMax} value={row.body} />
				</div>
			</div>
		{/each}
	</fieldset>
{/snippet}

{#snippet blockActions(key: CmsBlockKey)}
	<input type="hidden" name="key" value={key} />
	<div class="actions">
		<button class="button small secondary" name="intent" value="draft">Guardar borrador</button>
		<button class="button small" name="intent" value="publish">Guardar y publicar</button>
	</div>
{/snippet}

{#snippet history(key: CmsBlockKey)}
	{@const current = block(key)}
	{@const versions = current.revisions}
	<div class="history">
		{#if current.draft}
			<form method="POST" action="?tab={tab}&/discard">
				<input type="hidden" name="key" value={key} />
				<button class="button small secondary">Descartar borrador</button>
			</form>
		{/if}
		{#if versions.length}
			<details>
				<summary class="small">Historial ({versions.length})</summary>
				<ul>
					{#each versions as revision (revision.version)}
						<li>
							<span>Versión {revision.version} · {dateTime(revision.publishedAt, timezone, 'short')}</span>
							<form method="POST" action="?tab={tab}&/restore">
								<input type="hidden" name="key" value={key} />
								<input type="hidden" name="version" value={revision.version} />
								<button class="link small">Recuperar como borrador</button>
							</form>
						</li>
					{/each}
				</ul>
			</details>
		{/if}
	</div>
{/snippet}

<header class="head">
	<div>
		<h1>Sitio</h1>
		<p class="muted small">Los cambios se guardan como borrador y se ven en el sitio recién al publicarlos. Cada publicación queda en el historial.</p>
	</div>
	<a class="button small secondary" href="/" target="_blank" rel="noopener">Ver el sitio</a>
</header>

<nav class="tabs" aria-label="Secciones del sitio">
	{#each tabs as candidate (candidate.id)}
		<a href="?tab={candidate.id}" aria-current={candidate.id === tab ? 'page' : undefined}>{candidate.label}</a>
	{/each}
</nav>

{#if tab === 'marca'}
	{@const content = values('brand')}
	<section class="panel" aria-labelledby="brand-title">
		<h2 id="brand-title">Marca</h2>
		{@render status('brand')}
		{@render message('brand')}
		<form method="POST" action="?tab=marca&/save" class="stack">
			<div class="row">
				{@render imageField('logo', 'Logo', content.logo)}
				{@render textField('logoAlt', 'Nombre para lectores de pantalla', content.logoAlt, { required: true, max: 120 })}
			</div>
			{@render textField('tagline', 'Bajada', content.tagline, { required: true, max: 160, hint: 'Aparece en el pie y en el título de la pestaña.' })}
			{@render blockActions('brand')}
		</form>
		{@render history('brand')}
	</section>
{:else if tab === 'inicio'}
	{@const content = values('home')}
	<section class="panel" aria-labelledby="home-title">
		<h2 id="home-title">Página de inicio</h2>
		{@render status('home')}
		{@render message('home')}
		<form method="POST" action="?tab=inicio&/save" class="stack">
			<div class="row">
				<div class="field">
					<label for="heroStyle">Estilo de la portada</label>
					<select id="heroStyle" name="heroStyle">
						<option value="simple" selected={content.heroStyle !== 'garage'}>Simple</option>
						<option value="garage" selected={content.heroStyle === 'garage'}>Garage (persiana)</option>
					</select>
				</div>
				<div class="field">
					<label for="processStyle">Estilo del proceso</label>
					<select id="processStyle" name="processStyle">
						<option value="list" selected={content.processStyle !== 'pistons'}>Lista</option>
						<option value="pistons" selected={content.processStyle === 'pistons'}>Pistones</option>
					</select>
				</div>
			</div>
			{@render textField('heroTitle', 'Título principal', content.heroTitle, { required: true, max: 120 })}
			{@render areaField('heroLead', 'Texto principal', content.heroLead, { required: true, max: 400 })}
			<div class="row">
				{@render imageField('heroImage', 'Imagen principal', content.heroImage)}
				{@render textField('heroImageAlt', 'Descripción de la imagen', content.heroImageAlt, { max: 200, hint: 'Qué se ve en la foto, para quien no puede verla.' })}
			</div>
			{@render textField('heroVideoUrl', 'Video (YouTube)', content.heroVideoUrl, { type: 'url', placeholder: 'https://www.youtube.com/watch?v=…', hint: 'Se muestra debajo de la portada.' })}
			{@render textField('servicesTitle', 'Título de servicios', content.servicesTitle, { max: 80 })}
			{@render rowsField('services', 'Servicios', content.services, 8)}
			{@render textField('processTitle', 'Título del proceso', content.processTitle, { max: 80 })}
			{@render rowsField('process', 'Pasos del proceso', content.process, 8)}
			{@render textField('ctaTitle', 'Título del cierre', content.ctaTitle, { max: 80, hint: 'Invitación a seguir la cuenta de Instagram, si está cargada.' })}
			{@render areaField('ctaBody', 'Texto del cierre', content.ctaBody, { max: 400 })}
			{@render blockActions('home')}
		</form>
		{@render history('home')}
	</section>
{:else if tab === 'seo'}
	{@const content = values('seo')}
	<section class="panel" aria-labelledby="seo-title">
		<h2 id="seo-title">Buscadores y redes</h2>
		<p class="muted small">Título, descripción e imagen que usan Google y las vistas previas de WhatsApp, Instagram o Facebook cuando alguien comparte el sitio.</p>
		{@render status('seo')}
		{@render message('seo')}
		<form method="POST" action="?tab=seo&/save" class="stack">
			{@render textField('title', 'Título', content.title, { required: true, max: 70, hint: 'Hasta 70 caracteres.' })}
			{@render areaField('description', 'Descripción', content.description, { required: true, max: 200 })}
			{@render imageField('image', 'Imagen para compartir', content.image)}
			{@render blockActions('seo')}
		</form>
		{@render history('seo')}
	</section>
{:else if tab === 'aviso'}
	{@const content = values('announcement')}
	<section class="panel" aria-labelledby="announcement-title">
		<h2 id="announcement-title">Aviso</h2>
		<p class="muted small">Una franja arriba de todas las páginas del sitio, para novedades breves.</p>
		{@render status('announcement')}
		{@render message('announcement')}
		<form method="POST" action="?tab=aviso&/save" class="stack">
			<label class="check"><input type="checkbox" name="enabled" defaultChecked={content.enabled === true} /> Mostrar el aviso</label>
			{@render textField('text', 'Texto', content.text, { required: true, max: 200 })}
			<div class="row">
				{@render textField('linkUrl', 'Enlace', content.linkUrl, { placeholder: '/sorteos/… o https://…' })}
				{@render textField('linkLabel', 'Texto del enlace', content.linkLabel, { max: 40 })}
			</div>
			{@render blockActions('announcement')}
		</form>
		{@render history('announcement')}
	</section>
{:else if tab === 'restauraciones'}
	{@const content = values('gallery')}
	<section class="panel" aria-labelledby="gallery-title">
		<h2 id="gallery-title">Restauraciones</h2>
		<p class="muted small">
			Una página de fotos en /restauraciones; elegí si además se ve un adelanto en el inicio y un enlace en el menú. Si usás fotos de otras personas, completá autor, licencia y fuente: el sitio las muestra junto a cada foto. Subí las
			fotos propias en la pestaña <a href="?tab=imagenes">Imágenes</a>.
		</p>
		{@render status('gallery')}
		{@render message('gallery')}
		<form method="POST" action="?tab=restauraciones&/save" class="stack">
			<label class="check"><input type="checkbox" name="enabled" defaultChecked={content.enabled === true} /> Mostrar la sección en el sitio</label>
			<label class="check"><input type="checkbox" name="showOnHome" defaultChecked={content.showOnHome === true} /> Mostrar un adelanto en el inicio</label>
			<label class="check"><input type="checkbox" name="showInMenu" defaultChecked={content.showInMenu === true} /> Mostrar en el menú</label>
			{@render textField('title', 'Título de la sección', content.title, { required: true, max: 80, placeholder: 'Restauraciones' })}
			{@render areaField('lead', 'Bajada', content.lead, { max: 400 })}
			{@render areaField('note', 'Aclaración', content.note, { max: 300 })}
			<p class="hint">La aclaración se ve arriba de las fotos; por ejemplo, que son fotos de ejemplo y no trabajos del taller.</p>
			<p class="hint">Hasta 12 fotos; el adelanto del inicio muestra las tres primeras. Dejá una foto vacía para quitarla.</p>
			{#each editableGalleryRows(content.items as GalleryRow[] | undefined, 12) as row, index (index)}
				{@render photoRow(row, index)}
			{/each}
			{@render blockActions('gallery')}
		</form>
		{@render history('gallery')}
	</section>
{:else if tab === 'legales'}
	{#each [{ key: 'legal.terms' as const, title: 'Términos y condiciones', accepted: data.legal.termsVersion }, { key: 'legal.privacy' as const, title: 'Privacidad', accepted: data.legal.privacyVersion }] as doc (doc.key)}
		{@const content = values(doc.key)}
		<section class="panel" aria-labelledby="{doc.key}-title">
			<h2 id="{doc.key}-title">{doc.title}</h2>
			<p class="muted small">
				Versión vigente: <strong>{doc.accepted}</strong>. Las compras guardan la versión aceptada, así que cada publicación necesita una versión nueva. Este texto lo
				redacta la organización con su asesoría legal.
			</p>
			{@render status(doc.key)}
			{@render message(doc.key)}
			<form method="POST" action="?tab=legales&/save" class="stack">
				{@render textField('version', 'Versión', content.version, { required: true, max: 40, placeholder: '2026-11', hint: 'Letras, números, punto o guion.' })}
				{@render rowsField('sections', 'Secciones', content.sections, 40, 6, 8000)}
				{@render blockActions(doc.key)}
			</form>
			{@render history(doc.key)}
		</section>
	{/each}
{:else if tab === 'preguntas'}
	<section class="panel" aria-labelledby="faq-title">
		<h2 id="faq-title">Preguntas frecuentes</h2>
		<p class="muted small">Las del sitio. Las de cada campaña se cargan en la campaña. Se publican al guardarlas.</p>
		{#each data.faqs as faq (faq.id)}
			<article class="faq">
				{@render message(`faq-${faq.id}`)}
				<form method="POST" action="?tab=preguntas&/updateFaq" class="stack">
					<input type="hidden" name="id" value={faq.id} />
					<div class="faq-head">
						<div class="field"><label for="question-{faq.id}">Pregunta</label><input id="question-{faq.id}" name="question" required minlength="5" maxlength="200" defaultValue={faq.question} /></div>
						<div class="field position"><label for="position-{faq.id}">Orden</label><input id="position-{faq.id}" name="position" type="number" min="0" max="1000" defaultValue={String(faq.position)} /></div>
					</div>
					<div class="field"><label for="answer-{faq.id}">Respuesta</label><TextArea id="answer-{faq.id}" name="answer" rows={3} required maxlength={2000} value={faq.answer} /></div>
					<div class="actions"><button class="button small secondary">Guardar pregunta</button></div>
				</form>
				<form method="POST" action="?tab=preguntas&/deleteFaq">
					<input type="hidden" name="id" value={faq.id} />
					<button class="link small danger">Borrar</button>
				</form>
			</article>
		{:else}
			<p class="muted">Todavía no hay preguntas.</p>
		{/each}
		{@render message('faq-new')}
		<form method="POST" action="?tab=preguntas&/addFaq" class="stack new-faq">
			<h3>Nueva pregunta</h3>
			<div class="faq-head">
				<div class="field"><label for="question-new">Pregunta</label><input id="question-new" name="question" required minlength="5" maxlength="200" /></div>
				<div class="field position"><label for="position-new">Orden</label><input id="position-new" name="position" type="number" min="0" max="1000" defaultValue={String(data.faqs.length + 1)} /></div>
			</div>
			<div class="field"><label for="answer-new">Respuesta</label><textarea id="answer-new" name="answer" rows="3" required minlength="5" maxlength="2000"></textarea></div>
			<div class="actions"><button class="button small">Agregar pregunta</button></div>
		</form>
	</section>
{:else}
	<section class="panel" aria-labelledby="media-title">
		<h2 id="media-title">Imágenes</h2>
		<p class="muted small">JPEG, PNG o WebP de hasta 2 MB. Son públicas: no subas documentos ni fotos con datos personales.</p>
		{@render message('media')}
		<form method="POST" action="?tab=imagenes&/upload" enctype="multipart/form-data" class="upload">
			<div class="field">
				<label for="image">Imagen</label>
				<input id="image" name="image" type="file" accept="image/jpeg,image/png,image/webp" required />
			</div>
			<button class="button">Subir imagen</button>
		</form>
		{#if data.media.length}
			<ul class="library">
				{#each data.media as media (media.id)}
					<li>
						<img src={media.url} alt="" loading="lazy" />
						<span class="name">{media.filename}</span>
						<span class="muted small">{kb(media.sizeBytes)} · {dateTime(media.createdAt, timezone, 'short')}</span>
						{#if media.inUse}
							<span class="chip ok">En uso</span>
						{:else}
							<form method="POST" action="?tab=imagenes&/deleteMedia">
								<input type="hidden" name="id" value={media.id} />
								<button class="link small danger">Borrar</button>
							</form>
						{/if}
					</li>
				{/each}
			</ul>
		{:else}
			<p class="muted">Todavía no subiste imágenes.</p>
		{/if}
	</section>
{/if}

<style>
	.head {
		display: flex;
		justify-content: space-between;
		align-items: start;
		gap: 1rem;
		margin-bottom: 1rem;
	}

	h1 {
		font-size: var(--step-4);
		text-transform: uppercase;
	}

	h2 {
		font-size: var(--step-1);
		text-transform: uppercase;
	}

	h3 {
		font-size: var(--step-0);
	}

	.tabs {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
		margin-bottom: 1rem;
	}

	.tabs a {
		padding: 0.45rem 0.8rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		text-decoration: none;
		font-weight: 600;
		font-size: var(--step--1);
	}

	.tabs a[aria-current='page'] {
		background: var(--text);
		color: var(--bg);
		border-color: var(--text);
	}

	.panel {
		margin-bottom: 1rem;
		display: grid;
		gap: 0.9rem;
	}

	.stack {
		display: grid;
		gap: 0.75rem;
	}

	.row {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
		gap: 0.75rem;
	}

	.status {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem;
		margin: 0;
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.6rem;
	}

	.rows {
		display: grid;
		gap: 0.75rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		padding: 0.9rem 1rem;
	}

	legend {
		font-weight: 700;
		padding-inline: 0.3rem;
	}

	.row-item {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 2fr);
		gap: 0.75rem;
	}

	.thumb {
		max-width: 180px;
		max-height: 110px;
		object-fit: cover;
		border-radius: var(--radius-sm);
		border: 1px solid var(--border);
	}

	.history {
		display: flex;
		flex-wrap: wrap;
		gap: 0.6rem 1.2rem;
		align-items: start;
	}

	.history ul {
		margin: 0.5rem 0 0;
		padding-left: 1.2rem;
		display: grid;
		gap: 0.3rem;
	}

	.history li {
		display: flex;
		flex-wrap: wrap;
		gap: 0.6rem;
		align-items: center;
	}

	.faq {
		display: grid;
		gap: 0.5rem;
		padding: 0.9rem 1rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		background: var(--surface-2);
	}

	.faq-head {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 7rem;
		gap: 0.75rem;
	}

	.new-faq {
		border-top: 1px solid var(--border);
		padding-top: 1rem;
	}

	.upload {
		display: flex;
		flex-wrap: wrap;
		gap: 0.75rem;
		align-items: end;
	}

	.library {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
		gap: 0.9rem;
	}

	.library li {
		display: grid;
		gap: 0.3rem;
		align-content: start;
	}

	.library img {
		width: 100%;
		aspect-ratio: 4 / 3;
		object-fit: cover;
		border-radius: var(--radius-sm);
		border: 1px solid var(--border);
	}

	.name {
		font-weight: 600;
		overflow-wrap: anywhere;
	}

	.link {
		background: none;
		border: 0;
		padding: 0;
		color: inherit;
		text-decoration: underline;
		cursor: pointer;
	}

	.danger {
		color: var(--danger);
	}

	summary {
		cursor: pointer;
		font-weight: 600;
	}

	.small {
		font-size: var(--step--1);
	}

	@media (max-width: 640px) {
		.row-item,
		.faq-head {
			grid-template-columns: 1fr;
		}
	}
</style>
