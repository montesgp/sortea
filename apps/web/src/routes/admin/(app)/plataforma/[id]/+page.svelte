<script lang="ts">
	import TextArea from '#lib/components/TextArea.svelte';
	import { dateTime } from '#lib/format.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const org = $derived(data.organization);
	const mercadoPago = $derived(org.integrations.filter((integration) => integration.provider === 'mercadopago'));
	const feedback = (action: string) => (form?.action === action ? form : null);
	const roleLabel: Record<string, string> = {
		org_owner: 'Dueño',
		org_admin: 'Administración',
		finance_manager: 'Finanzas',
		campaign_operator: 'Operación',
		auditor: 'Auditoría',
		support_agent: 'Atención'
	};
</script>

<svelte:head>
	<title>{org.name} | Plataforma</title>
</svelte:head>

{#snippet message(action: string)}
	{@const result = feedback(action)}
	{#if result}<p class="notice {result.ok ? 'ok' : 'error'}" role={result.ok ? 'status' : 'alert'}>{result.message}</p>{/if}
{/snippet}

<a class="small" href="/admin/plataforma">Volver a organizaciones</a>
<header class="head">
	<div>
		<h1>{org.name}</h1>
		<p class="muted small">{org.slug}, comprobantes {org.orderPrefix}-…, {org.timezone}</p>
	</div>
	<form method="POST" action="?/status">
		<input type="hidden" name="status" value={org.status === 'active' ? 'suspended' : 'active'} />
		<button class="button small secondary">{org.status === 'active' ? 'Suspender organización' : 'Reactivar organización'}</button>
	</form>
</header>
{@render message('status')}

<div class="grid">
	<section class="panel" aria-labelledby="mp-title">
		<h2 id="mp-title">Mercado Pago</h2>
		<p class="muted small">Las credenciales se cifran al guardarlas y nunca vuelven a mostrarse. Para cambiarlas, cargalas de nuevo.</p>
		{#each mercadoPago as integration (integration.mode)}
			<div class="integration">
				<p>
					<strong>{integration.mode === 'production' ? 'Producción' : 'Sandbox'}</strong>
					<span class="chip {integration.status === 'verified' ? 'ok' : integration.status === 'error' ? 'bad' : 'warn'}">{integration.status === 'verified' ? 'Verificada' : integration.status === 'error' ? 'Con error' : 'Sin verificar'}</span>
					{#if integration.isActive}<span class="chip neutral">Activa</span>{/if}
					{#if integration.simulator}<span class="chip warn">Simulador local</span>{/if}
				</p>
				<p class="small muted">
					Token {integration.secretHint}, versión {integration.version}, clave de cifrado v{integration.keyVersion}.
					{#if integration.collectorId}Cuenta {integration.collectorId}.{/if}
					{#if integration.lastVerifiedAt}Última verificación {dateTime(integration.lastVerifiedAt, org.timezone, 'short')}.{/if}
					{#if integration.lastError}Error: {integration.lastError}.{/if}
				</p>
			</div>
		{:else}
			<p class="notice">Sin credenciales: esta organización todavía no puede cobrar.</p>
		{/each}
		{@render message('verify')}
		{#if mercadoPago.length}
			<form method="POST" action="?/verify"><button class="button small secondary">Verificar conexión</button></form>
		{/if}
		{@render message('mercadopago')}
		<form method="POST" action="?/mercadopago" class="stack" autocomplete="off">
			<div class="field">
				<label for="mode">Entorno</label>
				<select id="mode" name="mode"><option value="sandbox">Sandbox (pruebas)</option><option value="production">Producción</option></select>
			</div>
			<div class="field"><label for="accessToken">Access token</label><input id="accessToken" name="accessToken" type="password" required autocomplete="off" /></div>
			<div class="field"><label for="webhookSecret">Clave secreta de notificaciones</label><input id="webhookSecret" name="webhookSecret" type="password" required autocomplete="off" /></div>
			<div class="field"><label for="publicKey">Public key <span class="muted">(opcional)</span></label><input id="publicKey" name="publicKey" autocomplete="off" /></div>
			<button class="button small">Guardar credenciales</button>
		</form>
	</section>

	<section class="panel" aria-labelledby="theme-title">
		<h2 id="theme-title">Tema</h2>
		<p class="muted small">Tokens de diseño en JSON: paletas dark y light (hex #rrggbb), radio, tipografías (archivo, big-shoulders, inter-tight, system) y densidad. Las combinaciones sin contraste AA se reemplazan por los valores por defecto.</p>
		{@render message('theme')}
		<form method="POST" action="?/theme" class="stack">
			<label class="visually-hidden" for="tokens">Tokens del tema</label>
			<TextArea id="tokens" name="tokens" rows={18} spellcheck="false" class="code" value={JSON.stringify(org.theme, null, 2)} />
			<button class="button small">Guardar tema</button>
		</form>
	</section>

	<section class="panel" aria-labelledby="domains-title">
		<h2 id="domains-title">Dominios</h2>
		<ul class="list">
			{#each org.domains as domain (domain.hostname)}
				<li><span>{domain.hostname}</span>{#if domain.isPrimary}<span class="chip neutral">Principal</span>{/if}</li>
			{/each}
		</ul>
		{@render message('domain')}
		<form method="POST" action="?/domain" class="stack">
			<div class="field"><label for="hostname">Nuevo dominio</label><input id="hostname" name="hostname" placeholder="www.ejemplo.com" required /></div>
			<label class="check"><input type="checkbox" name="isPrimary" /> <span>Usar como principal (enlaces de emails y pagos)</span></label>
			<button class="button small secondary">Agregar dominio</button>
		</form>
		<p class="muted small">Apuntá el DNS del dominio al servicio web antes de agregarlo.</p>
	</section>

	<section class="panel" aria-labelledby="members-title">
		<h2 id="members-title">Miembros</h2>
		<ul class="list">
			{#each org.members as member (member.email)}
				<li><span>{member.email}</span><span class="muted small">{roleLabel[member.role] ?? member.role}</span></li>
			{:else}
				<li class="muted">Sin miembros.</li>
			{/each}
		</ul>
	</section>
</div>

<style>
	.head {
		display: flex;
		justify-content: space-between;
		align-items: start;
		gap: 1rem;
		margin: 0.75rem 0 1.5rem;
	}

	h1 {
		font-size: var(--step-4);
		text-transform: uppercase;
	}

	h2 {
		font-size: var(--step-1);
		text-transform: uppercase;
	}

	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(380px, 1fr));
		gap: 1rem;
	}

	.panel {
		display: grid;
		gap: 0.9rem;
		align-content: start;
	}

	.integration {
		display: grid;
		gap: 0.3rem;
		padding-block: 0.6rem;
		border-bottom: 1px solid var(--border);
	}

	.integration p:first-child {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		align-items: center;
	}

	.stack {
		display: grid;
		gap: 0.9rem;
	}

	/* The textarea is rendered by TextArea, outside this component's scope. */
	.stack :global(.code) {
		font-family: ui-monospace, Consolas, monospace;
		font-size: 0.8rem;
	}

	.list {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.list li {
		display: flex;
		justify-content: space-between;
		gap: 1rem;
		padding-block: 0.6rem;
		border-bottom: 1px solid var(--border);
	}

	.small {
		font-size: var(--step--1);
	}
</style>
