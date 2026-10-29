<script lang="ts">
	import TextArea from '#lib/components/TextArea.svelte';
	import { dateTime } from '#lib/format.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const org = $derived(data.organization);
	const mercadoPago = $derived(org.integrations.filter((integration) => integration.provider === 'mercadopago'));
	const active = $derived(mercadoPago.find((integration) => integration.isActive));
	// Retired accounts keep their sealed credentials so the purchases created with them still settle.
	const retired = $derived(
		mercadoPago.filter((integration) => !integration.isActive).sort((a, b) => (b.retiredAt ?? '').localeCompare(a.retiredAt ?? ''))
	);
	const modeLabel = (mode: string) => (mode === 'production' ? 'Producción' : 'Sandbox');
	const feedback = (action: string) => (form?.action === action ? form : null);
	let copied = $state(false);
	async function copy(text: string) {
		await navigator.clipboard.writeText(text).catch(() => undefined);
		copied = true;
		setTimeout(() => (copied = false), 2000);
	}
	// A rejected number stays in the field to be corrected; otherwise show the saved one.
	const whatsappValue = $derived(form?.action === 'contact' && 'whatsapp' in form ? form.whatsapp : org.contact.whatsapp ? `+${org.contact.whatsapp}` : '');
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
		<p class="muted small">Al conectar, Mercado Pago confirma las credenciales antes de guardarlas. Se cifran y nunca vuelven a mostrarse; para cambiarlas, cargalas de nuevo.</p>
		{#if active}
			<div class="integration" role="group" aria-labelledby="mp-active-title">
				<h3 id="mp-active-title">Cuenta activa</h3>
				<p>
					<strong>{modeLabel(active.mode)}</strong>
					<span class="chip {active.status === 'verified' ? 'ok' : active.status === 'error' ? 'bad' : 'warn'}">{active.status === 'verified' ? 'Verificada' : active.status === 'error' ? 'Con error' : 'Sin verificar'}</span>
					<span class="chip neutral">Activa</span>
					{#if active.simulator}<span class="chip warn">Simulador local</span>{/if}
				</p>
				<p class="small muted">
					{#if active.collectorId}Cuenta {active.collectorId}.{/if}
					Token {active.secretHint}, versión {active.version}, clave de cifrado v{active.keyVersion}.
					{#if active.lastVerifiedAt}Última verificación {dateTime(active.lastVerifiedAt, org.timezone, 'short')}.{/if}
					{#if active.lastError}Error: {active.lastError}.{/if}
				</p>
			</div>
		{:else}
			<p class="notice">Sin credenciales: esta organización todavía no puede cobrar.</p>
		{/if}
		{#if retired.length}
			<div class="retired">
				<h3 id="mp-retired-title">Cuentas anteriores</h3>
				<p class="small muted">Se guardan para confirmar, conciliar y devolver los pagos de las compras que se iniciaron con ellas. No cobran compras nuevas hasta que vuelvas a usarlas; Mercado Pago revisa sus credenciales guardadas antes de activarlas.</p>
				{@render message('reactivate')}
				<ul class="list small" aria-labelledby="mp-retired-title">
					{#each retired as integration (integration.id)}
						<li>
							<span>Cuenta {integration.collectorId ?? 'sin identificar'}, {modeLabel(integration.mode)}, retirada el {integration.retiredAt ? dateTime(integration.retiredAt, org.timezone, 'short') : 'sin fecha'}.</span>
							<form method="POST" action="?/reactivate" class="reactivate">
								<input type="hidden" name="integrationId" value={integration.id} />
								<label class="check"><input type="checkbox" name="confirm" value="yes" required /> Entiendo que las compras nuevas se cobrarán con esta cuenta</label>
								<button class="button small secondary">Volver a usar esta cuenta</button>
							</form>
						</li>
					{/each}
				</ul>
			</div>
		{/if}
		{@render message('verify')}
		{@render message('disconnect')}
		{#if active}
			<form method="POST" action="?/verify"><button class="button small secondary">Verificar conexión</button></form>
		{/if}

		<div class="webhook">
			<h3 id="webhook-title">Notificaciones de pago</h3>
			<ol class="small">
				<li>En Mercado Pago Developers, abrí la aplicación de la cuenta y entrá a <strong>Webhooks</strong>.</li>
				<li>Pegá esta URL en el modo que vas a usar (pruebas o producción) y elegí el evento <strong>Pagos</strong>.</li>
				<li>Guardá y copiá la <strong>clave secreta</strong> que muestra: va en «Clave secreta de notificaciones».</li>
			</ol>
			<div class="copy">
				<label class="visually-hidden" for="webhookUrl">URL de notificaciones</label>
				<input id="webhookUrl" value={org.webhookUrl} readonly onfocus={(event) => event.currentTarget.select()} />
				<button type="button" class="button small secondary" onclick={() => copy(org.webhookUrl)}>{copied ? 'Copiada' : 'Copiar'}</button>
			</div>
		</div>

		{@render message('mercadopago')}
		<h3>{active ? 'Cambiar de cuenta' : 'Conectar cuenta'}</h3>
		{#if active}
			<div class="small switch">
				<p>El cambio vale para las compras que se inicien desde ahora. Las compras ya iniciadas se cobran, se confirman y se concilian con la cuenta con la que se crearon.</p>
				<ol>
					<li>Antes de cambiar, en la cuenta nueva configurá <strong>Webhooks</strong> con el evento <strong>Pagos</strong> y la misma URL de notificaciones de arriba.</li>
					<li>Después, no borres el webhook de la cuenta anterior: por ahí siguen llegando sus pagos pendientes, devoluciones y contracargos.</li>
				</ol>
				<p class="muted">Para renovar las credenciales de la misma cuenta, cargalas acá: se actualiza la cuenta activa.</p>
			</div>
		{/if}
		<form method="POST" action="?/mercadopago" class="stack" autocomplete="off">
			{#if active}<input type="hidden" name="previous" value="{active.mode}:{active.collectorId ?? ''}" />{/if}
			<div class="field">
				<label for="mode">Entorno</label>
				<select id="mode" name="mode"><option value="sandbox">Sandbox (pruebas)</option><option value="production">Producción</option></select>
			</div>
			<div class="field"><label for="accessToken">Access token</label><input id="accessToken" name="accessToken" type="password" required autocomplete="off" /></div>
			<div class="field"><label for="webhookSecret">Clave secreta de notificaciones</label><input id="webhookSecret" name="webhookSecret" type="password" required autocomplete="off" /></div>
			<div class="field"><label for="publicKey">Public key <span class="muted">(opcional)</span></label><input id="publicKey" name="publicKey" autocomplete="off" /></div>
			<button class="button small">Conectar cuenta</button>
		</form>

		{#if mercadoPago.length}
			<form method="POST" action="?/disconnect" class="stack disconnect">
				<h3>Desvincular cuenta</h3>
				<p class="small muted">Borra todas las cuentas, la activa y las anteriores, con sus credenciales, y el sitio deja de cobrar. No se puede mientras alguna tenga pagos en curso (las órdenes vencen a la hora) o en acreditación.</p>
				<label class="check small"><input type="checkbox" name="confirm" value="yes" required /> Entiendo que se borran las credenciales de todas las cuentas y el sitio deja de cobrar</label>
				<button class="button small secondary danger">Desvincular cuenta</button>
			</form>
		{/if}
	</section>

	<section class="panel" aria-labelledby="contact-title">
		<h2 id="contact-title">Contacto</h2>
		<p class="muted small">El número de WhatsApp se muestra como botón en todas las páginas públicas del sitio. Dejalo vacío para ocultarlo.</p>
		{@render message('contact')}
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
		<h3 id="social-title">Redes sociales</h3>
		{@render message('social')}
		<form method="POST" action="?/social" class="stack" aria-labelledby="social-title">
			{#each [['instagram', 'Instagram'], ['tiktok', 'TikTok'], ['youtube', 'YouTube'], ['facebook', 'Facebook']] as const as [key, label] (key)}
				<div class="field">
					<label for="social-{key}">{label}</label>
					<input id="social-{key}" name={key} type="url" inputmode="url" autocomplete="off" defaultValue={org.social?.[key] ?? ''} />
				</div>
			{/each}
			<button class="button small">Guardar redes</button>
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

	.integration p:nth-of-type(1) {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		align-items: center;
	}

	.retired,
	.switch {
		display: grid;
		gap: 0.4rem;
	}

	.switch p,
	.switch ol {
		margin: 0;
	}

	.switch ol {
		display: grid;
		gap: 0.3rem;
		padding-left: 1.2rem;
	}

	.stack {
		display: grid;
		gap: 0.9rem;
	}

	h3 {
		font-size: var(--step-0);
	}

	.webhook {
		display: grid;
		gap: 0.6rem;
		padding: 0.9rem;
		border: 1px dashed var(--border);
		border-radius: var(--radius-sm);
	}

	.webhook ol {
		display: grid;
		gap: 0.3rem;
		margin: 0;
		padding-left: 1.2rem;
	}

	.copy {
		display: flex;
		gap: 0.5rem;
	}

	.copy input {
		flex: 1;
		min-width: 0;
		font-family: ui-monospace, Consolas, monospace;
		font-size: 0.8rem;
	}

	.retired .list li {
		flex-direction: column;
		gap: 0.5rem;
	}

	.reactivate {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem 1rem;
		align-items: center;
	}

	.disconnect {
		padding-top: 0.9rem;
		border-top: 1px solid var(--border);
	}

	.disconnect .danger {
		justify-self: start;
		color: var(--danger);
		border-color: var(--danger);
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
