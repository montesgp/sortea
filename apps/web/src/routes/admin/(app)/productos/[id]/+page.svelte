<script lang="ts">
	import DateField from '#lib/components/DateField.svelte';
	import FileInput from '#lib/components/FileInput.svelte';
	import TextArea from '#lib/components/TextArea.svelte';
	import { minorToInput, productKindLabel, productStatusLabel } from '#lib/catalog.js';
	import { chancesText } from '#lib/chances.js';
	import { fileSize } from '#lib/file-size.js';
	import { money } from '#lib/format.js';
	import { PRODUCT_FILE_ACCEPT, productFileKindLabel } from '#lib/product-files.js';
	import { PRODUCT_FILES_MAX } from '@sortea/domain';
	import { dateTimeFieldValue } from '#lib/date-input.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const product = $derived(data.product);
	const timezone = $derived(data.session.organization.timezone);
	const canManage = $derived(data.session.permissions.includes('catalog.manage'));
	const status = $derived(productStatusLabel[product.status] ?? { label: product.status, tone: 'neutral' as const });
	const feedback = (target: string) => (form?.target === target ? form : null);
	const nextStatuses = $derived(
		(
			{
				draft: [{ to: 'active', label: 'Poner a la venta' }, { to: 'archived', label: 'Archivar' }],
				active: [{ to: 'draft', label: 'Pasar a borrador' }, { to: 'archived', label: 'Archivar' }],
				archived: [{ to: 'draft', label: 'Recuperar como borrador' }]
			} as Record<string, { to: string; label: string }[]>
		)[product.status] ?? []
	);
</script>

<svelte:head>
	<title>{product.name} | Productos</title>
</svelte:head>

{#snippet message(target: string)}
	{@const result = feedback(target)}
	{#if result}<p class="notice {result.ok ? 'ok' : 'error'}" role={result.ok ? 'status' : 'alert'}>{result.message}</p>{/if}
{/snippet}

{#snippet variantForm(variant: (typeof product.variants)[number] | null)}
	<input type="hidden" name="timezone" value={timezone} />
	{#if variant}<input type="hidden" name="variantId" value={variant.id} />{/if}
	<div class="row">
		<div class="field"><label for="sku-{variant?.id ?? 'new'}">Código (SKU)</label><input id="sku-{variant?.id ?? 'new'}" name="sku" required defaultValue={variant?.sku ?? ''} /></div>
		<div class="field"><label for="vname-{variant?.id ?? 'new'}">Nombre</label><input id="vname-{variant?.id ?? 'new'}" name="name" required minlength="2" defaultValue={variant?.name ?? ''} /></div>
		<div class="field">
			<label for="price-{variant?.id ?? 'new'}">Precio final ({data.session.organization.currency})</label>
			<input id="price-{variant?.id ?? 'new'}" name="price" inputmode="decimal" required placeholder="12.000" defaultValue={variant ? minorToInput(variant.priceMinor) : ''} />
		</div>
	</div>
	<div class="row">
		<div class="field">
			<label for="stock-{variant?.id ?? 'new'}">Stock</label>
			<input id="stock-{variant?.id ?? 'new'}" name="stock" inputmode="numeric" placeholder="Sin control" defaultValue={variant?.stock === null || variant?.stock === undefined ? '' : String(variant.stock)} />
		</div>
		<div class="field"><label for="max-{variant?.id ?? 'new'}">Máximo por compra</label><input id="max-{variant?.id ?? 'new'}" name="maxPerOrder" type="number" min="1" max="100" defaultValue={String(variant?.maxPerOrder ?? 5)} /></div>
		<div class="field"><label for="from-{variant?.id ?? 'new'}">A la venta desde ({timezone})</label><DateField id="from-{variant?.id ?? 'new'}" name="availableFrom" timeLabel="Hora de inicio de la venta" {...dateTimeFieldValue(variant?.availableFrom ?? null, timezone)} /></div>
		<div class="field"><label for="until-{variant?.id ?? 'new'}">Hasta</label><DateField id="until-{variant?.id ?? 'new'}" name="availableUntil" timeLabel="Hora de fin de la venta" {...dateTimeFieldValue(variant?.availableUntil ?? null, timezone)} /></div>
	</div>
	{#if variant}
		<label class="check"><input type="checkbox" name="active" defaultChecked={variant.active} /> Activa (se puede comprar)</label>
	{/if}
{/snippet}

<a class="small" href="/admin/productos">Volver a productos</a>
<header class="head">
	<div>
		<h1>{product.name}</h1>
		<p class="muted small">{productKindLabel[product.kind]} · /{product.slug}</p>
	</div>
	<span class="chip {status.tone}">{status.label}</span>
</header>

{#if canManage}
	<section class="panel" aria-labelledby="status-title">
		<h2 id="status-title">Disponibilidad</h2>
		{@render message('status')}
		<div class="actions">
			{#each nextStatuses as next (next.to)}
				<form method="POST" action="?/status">
					<input type="hidden" name="status" value={next.to} />
					<button class="button small {next.to === 'active' ? '' : 'secondary'}">{next.label}</button>
				</form>
			{/each}
		</div>
		<p class="muted small">Para ponerlo a la venta hace falta al menos una variante activa. Archivar lo saca de la tienda sin borrar los pedidos.</p>
	</section>
{/if}

<section class="panel" aria-labelledby="variants-title">
	<h2 id="variants-title">Variantes y precios</h2>
	<p class="muted small">Cada pedido guarda el precio con el que se hizo: cambiar un precio solo afecta a las compras nuevas.</p>
	{#each product.variants as variant (variant.id)}
		<article class="variant">
			<div class="variant-head">
				<strong>{variant.name}</strong>
				<span class="muted small">{variant.sku}</span>
				<span class="money">{money(variant.priceMinor, variant.currency)}</span>
				<span class="small">{variant.stock === null ? 'Stock sin control' : `${variant.stock} en stock`} · {variant.soldUnits} vendidas</span>
				<span class="chip {variant.active ? 'ok' : 'neutral'}">{variant.active ? 'Activa' : 'Inactiva'}</span>
			</div>
			{@render message(`variant-${variant.id}`)}
			{#if canManage}
				<details open={feedback(`variant-${variant.id}`)?.ok === false}>
					<summary class="small">Editar</summary>
					<form method="POST" action="?/updateVariant" class="stack">
						{@render variantForm(variant)}
						<button class="button small">Guardar variante</button>
					</form>
				</details>
			{/if}
		</article>
	{:else}
		<p class="muted">Todavía no tiene variantes.</p>
	{/each}

	{#if canManage}
		{@render message('new-variant')}
		<details open={product.variants.length === 0 || feedback('new-variant')?.ok === false}>
			<summary class="small">Agregar variante</summary>
			<form method="POST" action="?/addVariant" class="stack">
				{@render variantForm(null)}
				<button class="button small secondary">Agregar variante</button>
			</form>
		</details>
	{/if}
</section>

<section class="panel" aria-labelledby="chances-title">
	<h2 id="chances-title">Chances en campañas</h2>
	<p class="muted small">Se configuran en cada campaña, junto con sus bases. Cada chance es un cupón numerado en el sorteo.</p>
	{#if product.chances.length === 0}
		<p class="muted">No suma chances en ninguna campaña.</p>
	{:else}
		<ul class="chances">
			{#each product.chances as campaign (campaign.campaignId)}
				<li>
					<a href="/admin/campanas/{campaign.campaignId}">{campaign.campaignTitle}</a>
					<span class="muted small">{campaign.locked ? 'fijadas con las bases publicadas' : 'editables hasta la apertura'}</span>
					<ul>
						{#each product.variants.filter((variant) => campaign.perUnit[variant.id]) as variant (variant.id)}
							<li>{variant.name}: {chancesText(campaign.perUnit[variant.id]!)} por unidad</li>
						{/each}
					</ul>
				</li>
			{/each}
		</ul>
	{/if}
</section>

{#if canManage}
	<section class="panel" aria-labelledby="product-title">
		<h2 id="product-title">Datos del producto</h2>
		{@render message('product')}
		<form method="POST" action="?/update" class="stack">
			<div class="row">
				<div class="field"><label for="name">Nombre</label><input id="name" name="name" required defaultValue={product.name} /></div>
				<div class="field"><label for="slug">Dirección en la tienda</label><input id="slug" name="slug" required pattern="[a-z0-9]+(-[a-z0-9]+)*" defaultValue={product.slug} /></div>
				{#if product.kindLocked}
					<div class="field"><span class="label">Tipo</span><p class="small">{productKindLabel[product.kind]} (fijo: ya tiene pedidos)</p></div>
				{:else}
					<div class="field">
						<label for="kind">Tipo</label>
						<select id="kind" name="kind">
							<option value="digital" selected={product.kind === 'digital'}>Digital</option>
							<option value="physical" selected={product.kind === 'physical'}>Físico</option>
						</select>
					</div>
				{/if}
			</div>
			<div class="field"><label for="description">Descripción</label><TextArea id="description" name="description" rows={4} required value={product.description} /></div>
			<div class="row">
				<div class="field">
					<label for="imageUrl">Imagen</label>
					<input id="imageUrl" name="imageUrl" placeholder="/tenants/… o https://…" defaultValue={product.imageUrl ?? ''} />
				</div>
				<div class="field"><label for="position">Orden en la tienda</label><input id="position" name="position" type="number" min="0" defaultValue={String(product.position)} /></div>
			</div>
			<button class="button small">Guardar producto</button>
		</form>
	</section>
{/if}

<section class="panel" aria-labelledby="files-title">
	<h2 id="files-title">Archivos para descargar</h2>
	{#if product.kind === 'digital'}
		<p class="muted small">
			Quien lo compre recibe un botón de descarga por cada archivo, en este orden, en el email de compra y en Consultar. Subí las imágenes sueltas (PNG o JPEG) en lugar de un ZIP: en el teléfono se abren directo.
		</p>
	{/if}
	{@render message('files')}
	{#if product.assets.length}
		<ol class="files">
			{#each product.assets as asset (asset.id)}
				<li class="file">
					<div><span class="filename">{asset.filename}</span> <span class="muted small">{productFileKindLabel(asset.contentType)} · {fileSize(asset.sizeBytes)}</span></div>
					{@render message(`file-${asset.id}`)}
					{#if canManage && product.kind === 'digital'}
						<details open={feedback(`file-${asset.id}`)?.ok === false}>
							<summary class="small">Reemplazar o quitar</summary>
							<form method="POST" action="?/replaceFile" enctype="multipart/form-data" class="stack">
								<input type="hidden" name="fileId" value={asset.id} />
								<div class="row">
									<div class="field">
										<label for="file-{asset.id}">Archivo nuevo</label>
										<FileInput id="file-{asset.id}" name="file" accept={PRODUCT_FILE_ACCEPT} required current={{ name: asset.filename, sizeBytes: asset.sizeBytes }} />
									</div>
									<div class="field">
										<label for="name-{asset.id}">Nombre de la descarga (opcional)</label>
										<input id="name-{asset.id}" name="name" maxlength="150" placeholder="El del archivo" />
									</div>
								</div>
								<p class="muted small">Los enlaces que ya se enviaron para este archivo pasan a entregar el nuevo.</p>
								<button class="button small secondary">Reemplazar archivo</button>
							</form>
							<form method="POST" action="?/removeFile" class="remove">
								<input type="hidden" name="fileId" value={asset.id} />
								<input type="hidden" name="filename" value={asset.filename} />
								<label class="check small"><input type="checkbox" name="confirm" required /> Entiendo que los enlaces de este archivo dejan de funcionar, también los de quienes ya lo compraron</label>
								<button class="button small secondary">Quitar {asset.filename}</button>
							</form>
						</details>
					{/if}
				</li>
			{/each}
		</ol>
	{:else}
		<p class="muted small">{product.kind === 'digital' ? 'Este producto digital todavía no tiene archivos: quien lo compre no recibirá descargas.' : 'Los productos físicos no llevan archivos.'}</p>
	{/if}
	{#if canManage && product.kind === 'digital'}
		{#if product.assets.length < PRODUCT_FILES_MAX}
			<details open={product.assets.length === 0 || feedback('files')?.ok === false}>
				<summary class="small">Agregar archivo</summary>
				<form method="POST" action="?/addFile" enctype="multipart/form-data" class="stack">
					<div class="row">
						<div class="field">
							<label for="new-file">Archivo</label>
							<FileInput id="new-file" name="file" accept={PRODUCT_FILE_ACCEPT} required />
						</div>
						<div class="field">
							<label for="new-file-name">Nombre de la descarga (opcional)</label>
							<input id="new-file-name" name="name" maxlength="150" placeholder="El del archivo" />
						</div>
					</div>
					<p class="muted small">PDF, ZIP, PNG o JPEG de hasta 50 MB. El nombre queda sin acentos ni espacios para que se lea igual en cualquier teléfono.</p>
					<button class="button small secondary">Agregar archivo</button>
				</form>
			</details>
		{:else}
			<p class="muted small">Un producto entrega hasta {PRODUCT_FILES_MAX} archivos: quitá uno para agregar otro.</p>
		{/if}
	{/if}
</section>

<style>
	.head {
		display: flex;
		justify-content: space-between;
		align-items: start;
		gap: 1rem;
		margin: 0.75rem 0 1.25rem;
	}

	h1 {
		font-size: var(--step-4);
		text-transform: uppercase;
	}

	h2 {
		font-size: var(--step-1);
		text-transform: uppercase;
	}

	.panel {
		margin-bottom: 1rem;
		display: grid;
		gap: 0.9rem;
	}

	.stack {
		display: grid;
		gap: 0.75rem;
		margin-top: 0.6rem;
	}

	.row {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
		gap: 0.75rem;
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.6rem;
	}

	.variant {
		display: grid;
		gap: 0.5rem;
		padding: 0.9rem 1rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		background: var(--surface-2);
	}

	.variant-head {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem 1rem;
		align-items: center;
	}

	.chances {
		margin: 0;
		padding-left: 1.2rem;
		display: grid;
		gap: 0.5rem;
	}

	.chances span {
		margin-left: 0.5rem;
	}

	.files {
		margin: 0;
		padding-left: 1.2rem;
		display: grid;
		gap: 0.6rem;
	}

	.file {
		display: grid;
		gap: 0.35rem;
	}

	.remove {
		display: grid;
		gap: 0.5rem;
		justify-items: start;
		margin-top: 0.6rem;
	}

	/* The whole name of the file, wrapped: names are long and have no spaces (S12). */
	.filename {
		font-weight: 600;
		overflow-wrap: anywhere;
	}

	summary {
		cursor: pointer;
		font-weight: 600;
	}

	.label {
		font-weight: 700;
		font-size: var(--step--1);
	}

	.small {
		font-size: var(--step--1);
	}
</style>
