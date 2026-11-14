<script lang="ts">
	import PasswordInput from '#lib/components/PasswordInput.svelte';
	import TextArea from '#lib/components/TextArea.svelte';
	import { dateTime } from '#lib/format.js';
	import { platformTab, platformTabs } from '#lib/platform-tabs.js';
	import { page } from '$app/state';
	import type { PageProps } from './$types';

	type Integration = PageProps['data']['organization']['integrations'][number];

	let { data, form }: PageProps = $props();
	const org = $derived(data.organization);
	const tab = $derived(platformTab(page.url.searchParams));
	const suspended = $derived(org.status !== 'active');
	// "Suspender" or "Reactivar" asks first; the status named here shows "Sí, …" and "Cancelar".
	const confirmingStatus = $derived(form?.action === 'status' && 'confirm' in form ? form.confirm : null);
	const mercadoPago = $derived(org.integrations.filter((integration) => integration.provider === 'mercadopago'));
	// The principal charges new purchases; the backup is verified and ready to take over (S4, L2).
	const principal = $derived(mercadoPago.find((integration) => integration.role === 'principal'));
	const backup = $derived(mercadoPago.find((integration) => integration.role === 'backup'));
	// Previous accounts keep their sealed credentials so the purchases created with them still settle.
	const previous = $derived(
		mercadoPago.filter((integration) => integration.role === 'previous').sort((a, b) => (b.retiredAt ?? '').localeCompare(a.retiredAt ?? ''))
	);
	// "Usar como principal" or "Volver a usar esta cuenta" asks first; the account named here shows the code field.
	const confirmingSwitch = $derived(form?.action === 'activate' && 'confirm' in form ? form.confirm : null);
	// "Desvincular cuenta" asks first, then for the code (S5).
	const confirmingDisconnect = $derived(form?.action === 'disconnect' && 'confirm' in form);
	const modeLabel = (mode: string) => (mode === 'production' ? 'Producción' : 'Sandbox');
	const statusChip = (status: string) =>
		status === 'verified' ? { tone: 'ok', label: 'Verificada' } : status === 'error' ? { tone: 'bad', label: 'Con error' } : { tone: 'warn', label: 'Sin verificar' };
	const feedback = (action: string) => (form?.action === action && 'message' in form ? form : null);
	// Results of one account's verification or credentials show on that account.
	const feedbackOn = (action: string, integrationId: string) =>
		form?.action === action && 'message' in form && 'integrationId' in form && form.integrationId === integrationId ? form : null;
	// "Quitar" on a domain row asks first; the row named here shows "Sí, quitar" and "Cancelar".
	const confirming = $derived(form?.action === 'removeDomain' && 'confirm' in form ? form.confirm : null);
	const secretHint = 'En Mercado Pago: tu aplicación → Configuración de webhooks → Firma secreta. No es el Client Secret de Credenciales.';
	let copied = $state(false);
	async function copy(text: string) {
		await navigator.clipboard.writeText(text).catch(() => undefined);
		copied = true;
		setTimeout(() => (copied = false), 2000);
	}
	// A rejected number stays in the field to be corrected; otherwise show the saved one.
	const whatsappValue = $derived(form?.action === 'contact' && 'whatsapp' in form ? form.whatsapp : org.contact.whatsapp ? `+${org.contact.whatsapp}` : '');
	const mapsValue = $derived(form?.action === 'contact' && 'mapsUrl' in form ? form.mapsUrl : (org.contact.mapsUrl ?? ''));
	const roleLabel: Record<string, string> = {
		org_owner: 'Dueño',
		org_admin: 'Administración',
		finance_manager: 'Finanzas',
		campaign_operator: 'Operación',
		auditor: 'Auditoría',
		support_agent: 'Atención',
		draw_host: 'Conductor del sorteo'
	};
	const roles = Object.entries(roleLabel);
	// A rejected "Agregar persona" keeps what was typed; a new account's temporary password shows once.
	const memberForm = $derived(form?.action === 'members' ? form : null);
	const memberEmail = $derived(memberForm && 'email' in memberForm ? String(memberForm.email) : '');
	const memberRole = $derived(memberForm && 'role' in memberForm ? String(memberForm.role) : 'draw_host');
	const temporaryPassword = $derived(memberForm && 'temporaryPassword' in memberForm ? String(memberForm.temporaryPassword) : null);
</script>

<svelte:head>
	<title>{org.name} | Plataforma</title>
</svelte:head>

{#snippet message(action: string)}
	{@const result = feedback(action)}
	{#if result}<p class="notice {result.ok ? 'ok' : 'error'}" role={result.ok ? 'status' : 'alert'}>{result.message}</p>{/if}
{/snippet}

{#snippet credentialsForm(integration: Integration)}
	<details class="credentials">
		<summary>Actualizar credenciales</summary>
		<form method="POST" action="?tab=mercadopago&/credentials" class="stack" autocomplete="off">
			<input type="hidden" name="integrationId" value={integration.id} />
			<p class="small muted">Completá solo lo que cambia: lo que dejes vacío queda como está. El access token nuevo tiene que ser de esta misma cuenta; para cobrar con otra, conectala como cuenta de respaldo.</p>
			<div class="field">
				<label for="token-{integration.id}">Access token nuevo</label>
				<PasswordInput id="token-{integration.id}" name="accessToken" label="Access token nuevo" autocomplete="off" />
			</div>
			<div class="field">
				<label for="secret-{integration.id}">Firma secreta del webhook nueva</label>
				<PasswordInput id="secret-{integration.id}" name="webhookSecret" label="Firma secreta del webhook nueva" autocomplete="off" describedby="secret-{integration.id}-hint" />
				<p id="secret-{integration.id}-hint" class="muted small">{secretHint}</p>
			</div>
			<button class="button small secondary">Guardar credenciales</button>
		</form>
	</details>
{/snippet}

{#snippet resultOn(action: string, integrationId: string)}
	{@const result = feedbackOn(action, integrationId)}
	{#if result}<p class="notice {result.ok ? 'ok' : 'error'}" role={result.ok ? 'status' : 'alert'}>{result.message}</p>{/if}
{/snippet}

<!-- Connecting the first account (the principal) or the backup: Mercado Pago checks the credentials first. -->
{#snippet connectForm(role: 'principal' | 'backup')}
	{@const suffix = role === 'backup' ? '-backup' : ''}
	<form method="POST" action="?tab=mercadopago&/mercadopago" class="stack" autocomplete="off">
		<input type="hidden" name="role" value={role} />
		<div class="field">
			<label for="mode{suffix}">Entorno</label>
			<select id="mode{suffix}" name="mode"><option value="sandbox">Sandbox (pruebas)</option><option value="production">Producción</option></select>
		</div>
		<div class="field"><label for="accessToken{suffix}">Access token</label><PasswordInput id="accessToken{suffix}" name="accessToken" label="Access token" autocomplete="off" required /></div>
		<div class="field">
			<label for="webhookSecret{suffix}">Firma secreta del webhook</label>
			<PasswordInput id="webhookSecret{suffix}" name="webhookSecret" label="Firma secreta del webhook" autocomplete="off" required describedby="webhookSecret{suffix}-hint" />
			<p id="webhookSecret{suffix}-hint" class="muted small">{secretHint}</p>
		</div>
		<div class="field"><label for="publicKey{suffix}">Public key <span class="muted">(opcional)</span></label><input id="publicKey{suffix}" name="publicKey" autocomplete="off" /></div>
		<button class="button small" class:secondary={role === 'backup'}>{role === 'backup' ? 'Conectar cuenta de respaldo' : 'Conectar cuenta'}</button>
	</form>
{/snippet}

<!-- What an account is and how it is doing: mode, status, merchant, last notification signed with its secret. -->
{#snippet accountStatus(integration: Integration)}
	{@const chip = statusChip(integration.status)}
	<p class="chips">
		<strong>{modeLabel(integration.mode)}</strong>
		<span class="chip {chip.tone}">{chip.label}</span>
		{#if integration.role === 'principal'}<span class="chip ok">Activa</span>{:else if integration.role === 'backup'}<span class="chip neutral">Respaldo, no cobra</span>{/if}
		{#if integration.simulator}<span class="chip warn">Simulador local</span>{:else if integration.testUser}<span class="chip warn">Cuenta de prueba de Mercado Pago</span>{/if}
	</p>
	<p class="small muted">
		{#if integration.collectorId}Cuenta {integration.collectorId}.{/if}
		Token {integration.secretHint}, versión {integration.version}, clave de cifrado v{integration.keyVersion}.
		{#if integration.lastVerifiedAt}Última verificación {dateTime(integration.lastVerifiedAt, org.timezone)}.{/if}
		{#if integration.lastError}Error: {integration.lastError}.{/if}
	</p>
	<p class="small">
		{#if integration.lastWebhook}
			Última notificación firmada con esta cuenta: {dateTime(integration.lastWebhook.receivedAt, org.timezone)}, <span class="chip ok">Firma válida</span>
		{:else}
			Sin notificaciones de esta cuenta todavía. En su aplicación de Mercado Pago, usá «Simular notificación» en Configuración de webhooks para comprobar la firma secreta.
		{/if}
	</p>
	{@render resultOn('verify', integration.id)}
	<form method="POST" action="?tab=mercadopago&/verify">
		<input type="hidden" name="integrationId" value={integration.id} />
		<button class="button small secondary">Verificar conexión</button>
	</form>
	{@render resultOn('credentials', integration.id)}
	{@render credentialsForm(integration)}
{/snippet}

<!--
	"Usar como principal" (the backup) and "Volver a usar esta cuenta" (a previous account), in two steps (S5):
	the first says what will happen, the second asks for the platform admin's authenticator code.
-->
{#snippet switchStep(integration: Integration, label: string)}
	{#if confirmingSwitch === integration.id}
		{@const result = feedback('activate')}
		<form method="POST" action="?tab=mercadopago&/activate" class="stack confirm-switch" autocomplete="off">
			<input type="hidden" name="integrationId" value={integration.id} />
			<input type="hidden" name="confirm" value="yes" />
			<input type="hidden" name="from" value={integration.role} />
			<p class="small"><strong>¿{label}?</strong></p>
			<ul class="small">
				<li>Las compras nuevas se cobran con la cuenta {integration.collectorId ?? 'sin identificar'}.</li>
				<li>Las compras ya iniciadas siguen con la cuenta con la que se crearon.</li>
				{#if principal}
					<li>
						{#if integration.role === 'backup'}La cuenta {principal.collectorId ?? 'sin identificar'} queda como respaldo.{:else}La cuenta {principal.collectorId ?? 'sin identificar'} pasa a las cuentas anteriores.{/if}
					</li>
				{/if}
				<li>Antes de cambiar, Mercado Pago revisa las credenciales guardadas de esta cuenta.</li>
			</ul>
			{#if result && !result.ok}<p class="notice error" role="alert">{result.message}</p>{/if}
			<div class="field">
				<label for="code-{integration.id}">Código de tu app de autenticación</label>
				<input id="code-{integration.id}" name="code" inputmode="numeric" pattern={'\\d{6}'} maxlength="6" autocomplete="one-time-code" required aria-describedby="code-{integration.id}-hint" />
				<p id="code-{integration.id}-hint" class="muted small">Los 6 dígitos que muestra ahora la app con la que verificás tu ingreso.</p>
			</div>
			<div class="actions">
				<button class="button small">Confirmar cambio</button>
				<a class="button small secondary" href="/admin/plataforma/{org.id}?tab=mercadopago">Cancelar</a>
			</div>
		</form>
	{:else}
		<form method="POST" action="?tab=mercadopago&/activate">
			<input type="hidden" name="integrationId" value={integration.id} />
			<button class="button small" class:secondary={integration.role !== 'backup'}>{label}</button>
		</form>
	{/if}
{/snippet}

<a class="small" href="/admin/plataforma">Volver a organizaciones</a>
<header class="head">
	<div>
		<h1>{org.name}</h1>
		<p class="muted small">{org.slug}, comprobantes {org.orderPrefix}-…, {org.timezone}</p>
	</div>
	<span class="chip {suspended ? 'bad' : 'ok'}">{suspended ? 'Suspendida' : 'Activa'}</span>
</header>
{#if suspended && tab !== 'estado'}
	<p class="notice error" role="status">Organización suspendida: su sitio muestra «Este sitio está pausado momentáneamente» y no vende. <a href="?tab=estado">Reactivarla</a></p>
{/if}

<nav class="tabs" aria-label="Secciones de la organización">
	{#each platformTabs as candidate (candidate.id)}
		<a href="?tab={candidate.id}" aria-current={candidate.id === tab ? 'page' : undefined}>{candidate.label}</a>
	{/each}
</nav>

{#if tab === 'mercadopago'}
	<section class="panel wide" aria-labelledby="mp-title">
		<h2 id="mp-title">Mercado Pago</h2>
		<p class="muted small">Al conectar, Mercado Pago confirma las credenciales antes de guardarlas. Se cifran y nunca vuelven a mostrarse; para cambiarlas, usá «Actualizar credenciales» en la cuenta.</p>
		{@render message('mercadopago')}
		{#if !(form?.action === 'activate' && 'confirm' in form)}{@render message('activate')}{/if}
		{#if principal}
			<p class="small">
				La <strong>cuenta principal</strong> cobra las compras nuevas. La <strong>cuenta de respaldo</strong> queda conectada y verificada, sin cobrar, lista para reemplazarla: con «Usar como principal» intercambian sus lugares, y para volver se repite lo mismo. Cambiar la cuenta que cobra pide el código de tu app de autenticación.
			</p>
			<div class="accounts">
				<div class="account" role="group" aria-labelledby="mp-principal-title">
					<h3 id="mp-principal-title">Cuenta principal</h3>
					{@render accountStatus(principal)}
				</div>
				<div class="account" class:empty={!backup} role="group" aria-labelledby="mp-backup-title">
					<h3 id="mp-backup-title">Cuenta de respaldo</h3>
					{#if backup}
						{@render accountStatus(backup)}
						{@render switchStep(backup, 'Usar como principal')}
						<details class="credentials">
							<summary>Reemplazar por otra cuenta</summary>
							<p class="small muted">La cuenta de respaldo actual pasa a las cuentas anteriores, con sus credenciales guardadas.</p>
							{@render connectForm('backup')}
						</details>
					{:else}
						<p class="small muted">Conectá otra cuenta de Mercado Pago para tenerla verificada y lista. No cobra hasta que la uses como principal. Antes, configurá en su aplicación los webhooks con la URL de notificaciones de abajo.</p>
						{@render connectForm('backup')}
					{/if}
				</div>
			</div>
		{:else}
			<p class="notice">Sin credenciales: esta organización todavía no puede cobrar.</p>
			<h3>Conectar cuenta</h3>
			{@render connectForm('principal')}
		{/if}

		{#if previous.length}
			<div class="retired">
				<h3 id="mp-retired-title">Cuentas anteriores</h3>
				<p class="small muted">Se guardan para confirmar, conciliar y devolver los pagos de las compras que se iniciaron con ellas. No cobran compras nuevas hasta que vuelvas a usarlas; Mercado Pago revisa sus credenciales guardadas antes de activarlas.</p>
				<ul class="list small" aria-labelledby="mp-retired-title">
					{#each previous as integration (integration.id)}
						<li>
							<span>Cuenta {integration.collectorId ?? 'sin identificar'}, {modeLabel(integration.mode)}{#if !integration.simulator && integration.testUser}, cuenta de prueba de Mercado Pago{/if}, retirada el {integration.retiredAt ? dateTime(integration.retiredAt, org.timezone) : 'sin fecha'}.</span>
							{@render resultOn('verify', integration.id)}
							<div class="row-actions">
								{@render switchStep(integration, 'Volver a usar esta cuenta')}
								<form method="POST" action="?tab=mercadopago&/verify">
									<input type="hidden" name="integrationId" value={integration.id} />
									<button class="button small secondary">Verificar conexión</button>
								</form>
							</div>
							{@render resultOn('credentials', integration.id)}
							{@render credentialsForm(integration)}
						</li>
					{/each}
				</ul>
			</div>
		{/if}

		<div class="webhook">
			<h3 id="webhook-title">Notificaciones de pago</h3>
			<p class="small muted">Todas las cuentas de esta organización, la principal, la de respaldo y las anteriores, notifican a la misma URL.</p>
			<ol class="small" aria-labelledby="webhook-title">
				<li>En Mercado Pago Developers, abrí la aplicación de la cuenta y entrá a <strong>Configuración de webhooks</strong>.</li>
				<li>Elegí el modo que vas a usar (Prueba o Producción) y pegá esta URL en su campo de URL.</li>
				<li>Elegí solo el evento <strong>Order (Mercado Pago)</strong> y también <strong>Contracargos</strong> si aparece.</li>
				<li>Guardá y copiá la <strong>Firma secreta</strong> que está al pie de esa pantalla (tocá el ojo para verla): va en «Firma secreta del webhook». No es el Client Secret de Credenciales.</li>
				<li>Con la cuenta conectada, usá <strong>Simular notificación</strong> y revisá en esa cuenta que la última notificación diga «Firma válida».</li>
			</ol>
			<div class="copy">
				<label class="visually-hidden" for="webhookUrl">URL de notificaciones</label>
				<input id="webhookUrl" value={org.webhookUrl} readonly onfocus={(event) => event.currentTarget.select()} />
				<button type="button" class="button small secondary" onclick={() => copy(org.webhookUrl)}>{copied ? 'Copiada' : 'Copiar'}</button>
			</div>
			<p class="small" id="mp-last-webhook">
				{#if org.lastWebhook}
					Última notificación de la organización: {dateTime(org.lastWebhook.receivedAt, org.timezone)},
					{#if org.lastWebhook.signatureValid}
						<span class="chip ok">Firma válida</span>
					{:else}
						<span class="chip bad">Firma rechazada</span> Ninguna cuenta tiene guardada esa firma secreta: cargá la de la aplicación que la envió en «Actualizar credenciales» de su cuenta.
					{/if}
				{:else}
					Todavía no llegó ninguna notificación.
				{/if}
			</p>
		</div>

		{#if mercadoPago.length}
			<!-- Two steps like "Usar como principal" (S5): what will happen, then the authenticator code. -->
			<div class="stack disconnect">
				<h3>Desvincular cuenta</h3>
				<p class="small muted">Borra todas las cuentas, la principal, la de respaldo y las anteriores, con sus credenciales, y el sitio deja de cobrar. No se puede mientras alguna tenga pagos en curso (las órdenes vencen a la hora) o en acreditación.</p>
				{#if confirmingDisconnect}
					{@const result = feedback('disconnect')}
					<form method="POST" action="?tab=mercadopago&/disconnect" class="stack confirm-switch" autocomplete="off">
						<input type="hidden" name="confirm" value="yes" />
						<p class="small"><strong>¿Desvincular Mercado Pago?</strong></p>
						<ul class="small">
							<li>Se borran todas las cuentas, la principal, la de respaldo y las anteriores, con sus credenciales.</li>
							<li>El sitio deja de cobrar en el acto.</li>
							<li>Para volver a cobrar hay que conectar una cuenta de nuevo.</li>
						</ul>
						{#if result && !result.ok}<p class="notice error" role="alert">{result.message}</p>{/if}
						<div class="field">
							<label for="code-disconnect">Código de tu app de autenticación</label>
							<input id="code-disconnect" name="code" inputmode="numeric" pattern={'\\d{6}'} maxlength="6" autocomplete="one-time-code" required aria-describedby="code-disconnect-hint" />
							<p id="code-disconnect-hint" class="muted small">Los 6 dígitos que muestra ahora la app con la que verificás tu ingreso.</p>
						</div>
						<div class="actions">
							<button class="button small secondary danger">Confirmar desvinculación</button>
							<a class="button small secondary" href="/admin/plataforma/{org.id}?tab=mercadopago">Cancelar</a>
						</div>
					</form>
				{:else}
					<form method="POST" action="?tab=mercadopago&/disconnect">
						<button class="button small secondary danger">Desvincular cuenta</button>
					</form>
				{/if}
			</div>
		{:else}
			{@render message('disconnect')}
		{/if}
	</section>
{:else if tab === 'contacto'}
	<section class="panel" aria-labelledby="contact-title">
		<h2 id="contact-title">Contacto</h2>
		<p class="muted small">El número de WhatsApp se muestra como botón en todas las páginas públicas del sitio. Dejalo vacío para ocultarlo.</p>
		{@render message('contact')}
		<form method="POST" action="?tab=contacto&/contact" class="stack">
			<div class="field">
				<label for="whatsapp">WhatsApp</label>
				<input
					id="whatsapp"
					name="whatsapp"
					type="tel"
					inputmode="tel"
					autocomplete="off"
					placeholder="+54 9 11 2345-6789"
					defaultValue={whatsappValue}
					aria-describedby="whatsapp-hint"
				/>
				<p id="whatsapp-hint" class="muted small">Con código de país; para celulares de Argentina, +54 9 y el código de área.</p>
			</div>
			<div class="field">
				<label for="mapsUrl">Ubicación en Google Maps</label>
				<input
					id="mapsUrl"
					name="mapsUrl"
					type="url"
					inputmode="url"
					autocomplete="off"
					placeholder="https://maps.app.goo.gl/…"
					defaultValue={mapsValue}
					aria-describedby="mapsUrl-hint"
				/>
				<p id="mapsUrl-hint" class="muted small">En Google Maps, abrí el lugar, tocá «Compartir» y pegá el enlace. Se muestra al pie del sitio con un pin de ubicación. Dejalo vacío para ocultarlo.</p>
			</div>
			<button class="button small">Guardar contacto</button>
		</form>
		<h3 id="social-title">Redes sociales</h3>
		{@render message('social')}
		<form method="POST" action="?tab=contacto&/social" class="stack" aria-labelledby="social-title">
			{#each [['instagram', 'Instagram'], ['tiktok', 'TikTok'], ['youtube', 'YouTube'], ['facebook', 'Facebook']] as const as [key, label] (key)}
				<div class="field">
					<label for="social-{key}">{label}</label>
					<input id="social-{key}" name={key} type="url" inputmode="url" autocomplete="off" defaultValue={org.social?.[key] ?? ''} />
				</div>
			{/each}
			<button class="button small">Guardar redes</button>
		</form>
	</section>
{:else if tab === 'tema'}
	<section class="panel" aria-labelledby="theme-title">
		<h2 id="theme-title">Tema</h2>
		<p class="muted small">Tokens de diseño en JSON: paletas dark y light (hex #rrggbb), radio, tipografías (archivo, big-shoulders, inter-tight, system) y densidad. Las combinaciones sin contraste AA se reemplazan por los valores por defecto.</p>
		{@render message('theme')}
		<form method="POST" action="?tab=tema&/theme" class="stack">
			<label class="visually-hidden" for="tokens">Tokens del tema</label>
			<TextArea id="tokens" name="tokens" rows={18} spellcheck="false" class="code" value={JSON.stringify(org.theme, null, 2)} />
			<button class="button small">Guardar tema</button>
		</form>
	</section>
{:else if tab === 'dominios'}
	<section class="panel" aria-labelledby="domains-title">
		<h2 id="domains-title">Dominios</h2>
		<ul class="list">
			{#each org.domains as domain (domain.hostname)}
				<li>
					<span class="host"><span class="hostname">{domain.hostname}</span>{#if domain.isPrimary}<span class="chip ok">Principal</span>{/if}</span>
					{#if confirming === domain.hostname}
						<form method="POST" action="?tab=dominios&/removeDomain" class="remove-domain">
							<input type="hidden" name="hostname" value={domain.hostname} />
							<input type="hidden" name="confirm" value="yes" />
							<span class="small">¿Quitar {domain.hostname}?</span>
							<button class="button small secondary danger">Sí, quitar</button>
							<a class="button small secondary" href="/admin/plataforma/{org.id}?tab=dominios">Cancelar</a>
						</form>
					{:else}
						<form method="POST" action="?tab=dominios&/removeDomain">
							<input type="hidden" name="hostname" value={domain.hostname} />
							<button class="button small secondary" aria-label="Quitar {domain.hostname}">Quitar</button>
						</form>
					{/if}
				</li>
			{/each}
		</ul>
		{@render message('domain')}
		<form method="POST" action="?tab=dominios&/domain" class="stack">
			<div class="field"><label for="hostname">Nuevo dominio</label><input id="hostname" name="hostname" placeholder="www.ejemplo.com" required /></div>
			<label class="check"><input type="checkbox" name="isPrimary" /> <span>Usar como principal (enlaces de emails y pagos)</span></label>
			<button class="button small secondary">Agregar dominio</button>
		</form>
		<p class="muted small">Apuntá el DNS del dominio al servicio web antes de agregarlo.</p>
	</section>
{:else if tab === 'miembros'}
	<section class="panel" aria-labelledby="members-title">
		<h2 id="members-title">Miembros</h2>
		{@render message('members')}
		{#if temporaryPassword}<p class="small">Contraseña temporal (se muestra una sola vez): <span class="hash">{temporaryPassword}</span>. La persona la cambia al entrar por primera vez.</p>{/if}
		<ul class="list">
			{#each org.members as member (member.userId)}
				<li class="member">
					<span>
						{#if member.alias}<strong>{member.alias}</strong> <span class="muted small">{member.email}</span>{:else}{member.email}{/if}
						{#if member.status !== 'active'}<span class="chip warn">Sin acceso</span>{/if}
					</span>
					<span class="member-actions">
						<form method="POST" action="?tab=miembros&/updateMember" class="inline">
							<input type="hidden" name="userId" value={member.userId} />
							<label class="visually-hidden" for="role-{member.userId}">Rol de {member.email}</label>
							<select id="role-{member.userId}" name="role">
								{#each roles as [value, label] (value)}<option {value} selected={value === member.role}>{label}</option>{/each}
							</select>
							<button class="button small secondary">Cambiar rol</button>
						</form>
						<form method="POST" action="?tab=miembros&/updateMember">
							<input type="hidden" name="userId" value={member.userId} />
							{#if member.status === 'active'}
								<input type="hidden" name="status" value="disabled" />
								<button class="button small secondary danger" aria-label="Quitar el acceso de {member.email}">Quitar acceso</button>
							{:else}
								<input type="hidden" name="status" value="active" />
								<button class="button small secondary" aria-label="Devolver el acceso de {member.email}">Devolver acceso</button>
							{/if}
						</form>
					</span>
				</li>
			{:else}
				<li class="muted">Sin miembros.</li>
			{/each}
		</ul>
		<form method="POST" action="?tab=miembros&/addMember" class="stack" aria-labelledby="add-member-title">
			<h3 id="add-member-title">Agregar persona</h3>
			<div class="field"><label for="member-email">Email</label><input id="member-email" name="email" type="email" autocomplete="off" value={memberEmail} required /></div>
			<div class="field">
				<label for="member-role">Rol</label>
				<select id="member-role" name="role">
					{#each roles as [value, label] (value)}<option {value} selected={value === memberRole}>{label}</option>{/each}
				</select>
			</div>
			<p class="muted small">«Conductor del sorteo» solo ve la sala del sorteo: carga la Quiniela, hace el sorteo en la app y busca cupones. No gestiona campañas, pedidos ni configuración.</p>
			<button class="button small secondary">Agregar persona</button>
		</form>
		<p class="muted small">El alias de cada usuario se edita en <a href="/admin/plataforma/usuarios">Usuarios</a>. Si la persona no tiene cuenta, se crea con una contraseña temporal.</p>
	</section>
{:else}
	<section class="panel" aria-labelledby="status-title">
		<h2 id="status-title">Estado</h2>
		{@render message('status')}
		{#if suspended}
			<p class="small">La organización está <strong>suspendida</strong>: su sitio público muestra «Este sitio está pausado momentáneamente», no vende ni acepta participaciones, y solo el equipo de plataforma entra a su panel.</p>
		{:else}
			<p class="small">La organización está <strong>activa</strong>. Al suspenderla, su sitio público muestra «Este sitio está pausado momentáneamente», deja de vender y de aceptar participaciones, y solo el equipo de plataforma entra a su panel, también desde sus propios dominios.</p>
		{/if}
		{#if confirmingStatus}
			<form method="POST" action="?tab=estado&/status" class="confirm-status">
				<input type="hidden" name="status" value={confirmingStatus} />
				<input type="hidden" name="confirm" value="yes" />
				{#if confirmingStatus === 'suspended'}
					<p class="small"><strong>¿Suspender {org.name}?</strong> El sitio deja de vender en el acto. Podés reactivarla desde esta pestaña.</p>
					<button class="button small secondary danger">Sí, suspender</button>
				{:else}
					<p class="small"><strong>¿Reactivar {org.name}?</strong> El sitio vuelve a publicarse y a vender con la configuración que tenía.</p>
					<button class="button small">Sí, reactivar</button>
				{/if}
				<a class="button small secondary" href="/admin/plataforma/{org.id}?tab=estado">Cancelar</a>
			</form>
		{:else}
			<form method="POST" action="?tab=estado&/status">
				<input type="hidden" name="status" value={suspended ? 'active' : 'suspended'} />
				<button class="button small secondary" class:danger={!suspended}>{suspended ? 'Reactivar organización' : 'Suspender organización'}</button>
			</form>
		{/if}
	</section>
{/if}

<style>
	.member {
		flex-wrap: wrap;
		gap: 0.5rem;
	}

	.member-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
		align-items: center;
	}

	.member-actions .inline {
		display: flex;
		gap: 0.4rem;
		align-items: center;
	}

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

	/* The tabs of /admin/sitio (S2). */
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
		display: grid;
		gap: 0.9rem;
		align-content: start;
		max-width: 760px;
	}

	/* The Mercado Pago tab uses the screen's width (S4). */
	.panel.wide {
		max-width: none;
	}

	/* Principal and backup side by side on wide screens, stacked on narrow ones. */
	.accounts {
		display: grid;
		gap: 1rem;
		grid-template-columns: minmax(0, 1fr);
		align-items: start;
	}

	@media (min-width: 60rem) {
		.accounts {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}

	.account {
		display: grid;
		gap: 0.6rem;
		align-content: start;
		padding: 1rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
	}

	.account.empty {
		border-style: dashed;
	}

	.account p {
		margin: 0;
	}

	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		align-items: center;
	}

	.confirm-switch {
		padding: 0.9rem;
		border: 1px solid var(--warning);
		border-radius: var(--radius-sm);
	}

	.confirm-switch ul {
		display: grid;
		gap: 0.3rem;
		margin: 0;
		padding-left: 1.2rem;
	}

	.confirm-switch input[name='code'] {
		max-width: 10rem;
		font-family: ui-monospace, Consolas, monospace;
		letter-spacing: 0.2em;
	}

	.actions,
	.row-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		align-items: center;
	}

	.retired {
		display: grid;
		gap: 0.4rem;
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

	.disconnect {
		padding-top: 0.9rem;
		border-top: 1px solid var(--border);
	}

	.credentials summary {
		cursor: pointer;
		font-size: var(--step--1);
	}

	.credentials[open] summary {
		margin-bottom: 0.6rem;
	}

	.remove-domain,
	.confirm-status {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		align-items: center;
	}

	.danger {
		color: var(--danger);
		border-color: var(--danger);
	}

	.disconnect .danger {
		justify-self: start;
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

	/* A long hostname wraps; the "Principal" pill keeps its gap and wraps below it (S1). */
	.host {
		display: inline-flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem;
		min-width: 0;
	}

	.hostname {
		overflow-wrap: anywhere;
	}

	.small {
		font-size: var(--step--1);
	}
</style>
