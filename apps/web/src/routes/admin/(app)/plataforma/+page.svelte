<script lang="ts">
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const values = $derived((form?.values ?? {}) as Record<string, string>);
	const paymentStatus: Record<string, string> = { verified: 'verificada', configured: 'sin verificar', error: 'con error' };
</script>

<svelte:head>
	<title>Plataforma | Panel</title>
</svelte:head>

<h1>Organizaciones</h1>
<p class="muted small">Cada organización tiene su dominio, tema, cuenta de Mercado Pago y datos aislados del resto.</p>

<div class="table-wrap">
	<table>
		<thead><tr><th scope="col">Organización</th><th scope="col">Estado</th><th scope="col">Dominios</th><th scope="col">Miembros</th><th scope="col">Pagos</th></tr></thead>
		<tbody>
			{#each data.organizations as org (org.id)}
				<tr>
					<td><a href="/admin/plataforma/{org.id}">{org.name}</a><br /><span class="muted small">{org.slug}</span></td>
					<td><span class="chip {org.status === 'active' ? 'ok' : 'bad'}">{org.status === 'active' ? 'Activa' : 'Suspendida'}</span></td>
					<td class="small">{org.domains.join(', ')}</td>
					<td>{org.members}</td>
					<td class="small">{org.payments ? `${org.payments.mode === 'production' ? 'Producción' : 'Sandbox'}, ${paymentStatus[org.payments.status] ?? org.payments.status}` : 'Sin configurar'}</td>
				</tr>
			{/each}
		</tbody>
	</table>
</div>

<section class="panel create" aria-labelledby="create-title">
	<h2 id="create-title">Nueva organización</h2>
	{#if form?.message}<p class="notice error" role="alert">{form.message}</p>{/if}
	<form method="POST" action="?/create" class="grid">
		<div class="field"><label for="name">Nombre</label><input id="name" name="name" required defaultValue={values.name ?? ''} /></div>
		<div class="field"><label for="slug">Identificador</label><input id="slug" name="slug" required pattern={'[a-z0-9-]{2,40}'} defaultValue={values.slug ?? ''} /><p class="hint">Minúsculas, números y guiones.</p></div>
		<div class="field"><label for="orderPrefix">Prefijo de comprobantes</label><input id="orderPrefix" name="orderPrefix" required pattern={'[A-Za-z]{2,4}'} maxlength="4" defaultValue={values.orderPrefix ?? ''} /></div>
		<div class="field"><label for="hostname">Dominio principal</label><input id="hostname" name="hostname" required placeholder="tienda.ejemplo.com" defaultValue={values.hostname ?? ''} /></div>
		<button class="button">Crear organización</button>
	</form>
</section>

<style>
	h1 {
		font-size: var(--step-4);
		text-transform: uppercase;
		margin-bottom: 0.5rem;
	}

	h2 {
		font-size: var(--step-1);
		text-transform: uppercase;
		margin-bottom: 1rem;
	}

	.small {
		font-size: var(--step--1);
	}

	.table-wrap {
		overflow-x: auto;
		margin: 1rem 0 1.5rem;
		border: 1px solid var(--border);
		border-radius: var(--radius);
	}

	table {
		width: 100%;
		border-collapse: collapse;
		font-size: var(--step--1);
	}

	th,
	td {
		padding: 0.8rem 1rem;
		text-align: left;
		border-bottom: 1px solid var(--border);
	}

	th {
		background: var(--surface);
	}

	/* Labels on one line; a field's hint goes below its input without moving the others. */
	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
		gap: 1rem;
		align-items: start;
	}

	.grid .button {
		grid-column: 1 / -1;
		justify-self: start;
	}
</style>
