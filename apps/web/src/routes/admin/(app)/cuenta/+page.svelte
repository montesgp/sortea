<script lang="ts">
	import { enhance, type SubmitFunction } from '$app/forms';
	import { adminModeChoice, adminModeChoices, applyAdminMode } from '#lib/admin-theme.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const alias = $derived(data.session.user.alias?.trim() || null);
	// "Olvidar los dispositivos recordados" asks first; its answers stay in its own section.
	const devicesForm = $derived(form && 'action' in form && form.action === 'forgetDevices' ? form : null);
	const confirmingForget = $derived(Boolean(devicesForm && 'confirm' in devicesForm));
	const themeMessage = $derived(form && !('action' in form) ? form.message : null);

	// The server renders the next load in the new mode; the open page switches at once.
	const saveTheme: SubmitFunction = ({ formData }) => {
		const choice = adminModeChoice(String(formData.get('theme') ?? ''));
		return async ({ result, update }) => {
			if (result.type === 'redirect') applyAdminMode(document.documentElement, choice, data.theme);
			await update();
		};
	};
</script>

<svelte:head>
	<title>Mi cuenta | Panel</title>
</svelte:head>

<h1>Mi cuenta</h1>

<div class="grid">
	<section class="panel" aria-labelledby="who-title">
		<h2 id="who-title">Tus datos</h2>
		<dl>
			{#if alias}
				<dt>Alias</dt>
				<dd>{alias}</dd>
			{/if}
			<dt>Email</dt>
			<dd class="email">{data.session.user.email}</dd>
		</dl>
	</section>

	<section class="panel" aria-labelledby="password-title">
		<h2 id="password-title">Contraseña</h2>
		<p class="muted small">Al cambiarla se cierran tus otras sesiones abiertas.</p>
		<a class="button secondary small" href="/admin/contrasena">Cambiar contraseña</a>
	</section>

	<section class="panel" aria-labelledby="mfa-title">
		<h2 id="mfa-title">Verificación en dos pasos</h2>
		{#if data.twoStep === 'verified'}
			<p><span class="chip ok">Activa</span></p>
			<p class="muted small">Tu sesión está verificada con tu app de autenticación. Para cambiar de app, pedíselo al equipo de la plataforma.</p>
		{:else if data.twoStep === 'unverified'}
			<p><span class="chip warn">Sin verificar en esta sesión</span></p>
			<p class="muted small">Tu app de autenticación ya está configurada. Ingresá un código para verificar esta sesión.</p>
			<a class="button secondary small" href="/admin/mfa">Verificar esta sesión</a>
		{:else if data.twoStep === 'pending'}
			<p><span class="chip warn">Configuración sin terminar</span></p>
			<p class="muted small">Escaneá el código QR con tu app de autenticación y confirmá el primer código.</p>
			<a class="button secondary small" href="/admin/mfa">Continuar la configuración</a>
		{:else}
			<p><span class="chip warn">Pendiente</span></p>
			<p class="muted small">
				{data.mfaRequired ? 'Tu organización exige este paso para usar el panel.' : 'El panel maneja pagos y datos personales: un segundo factor protege tu cuenta si alguien conoce tu contraseña.'}
			</p>
			<a class="button secondary small" href="/admin/mfa">Configurar app de autenticación</a>
		{/if}
	</section>

	<section class="panel" aria-labelledby="theme-title">
		<h2 id="theme-title">Tema</h2>
		<p class="muted small">Cómo se ve el panel en este navegador. El sitio público sigue con el tema de la organización.</p>
		{#if themeMessage}<p class="notice error" role="alert">{themeMessage}</p>{/if}
		<form method="POST" action="?/theme" class="stack" use:enhance={saveTheme}>
			<fieldset>
				<legend class="visually-hidden">Tema del panel</legend>
				{#each adminModeChoices as choice (choice.value)}
					<label class="check"><input type="radio" name="theme" value={choice.value} checked={data.theme === choice.value} />{choice.label}</label>
				{/each}
			</fieldset>
			<button class="button small">Guardar tema</button>
		</form>
	</section>

	<section class="panel" aria-labelledby="devices-title">
		<h2 id="devices-title">Dispositivos recordados</h2>
		{#if devicesForm && 'message' in devicesForm}
			<p class="notice {devicesForm.ok ? 'ok' : 'error'}" role={devicesForm.ok ? 'status' : 'alert'}>{devicesForm.message}</p>
		{/if}
		{#if data.trustedDevices === null}
			<p class="muted small">No pudimos consultar los dispositivos recordados. Probá de nuevo en unos minutos.</p>
		{:else if data.trustedDevices === 0}
			<p class="muted small">Ningún navegador entra sin pedirte el código.</p>
		{:else}
			<p class="muted small">
				{data.trustedDevices === 1 ? '1 navegador entra' : `${data.trustedDevices} navegadores entran`} sin pedirte el código: los marcaste con «Recordar este dispositivo por 30 días». Igual piden tu contraseña.
			</p>
		{/if}
		{#if confirmingForget && data.trustedDevices}
			<form method="POST" action="?/forgetDevices" class="stack">
				<input type="hidden" name="confirm" value="yes" />
				<p class="small">
					<strong>{data.trustedDevices === 1 ? '¿Olvidar el dispositivo recordado?' : `¿Olvidar los ${data.trustedDevices} dispositivos recordados?`}</strong>
					Al ingresar desde cualquiera de ellos, este incluido, te vamos a pedir el código.
				</p>
				<div class="actions">
					<button class="button small secondary danger">Sí, olvidarlos</button>
					<a class="button small secondary" href="/admin/cuenta">Cancelar</a>
				</div>
			</form>
		{:else if data.trustedDevices}
			<form method="POST" action="?/forgetDevices"><button class="button secondary small">Olvidar los dispositivos recordados</button></form>
		{/if}
	</section>

	<section class="panel" aria-labelledby="session-title">
		<h2 id="session-title">Sesión</h2>
		<p class="muted small">Cerrá la sesión al terminar, sobre todo en un equipo compartido.</p>
		<p class="muted small">Cerrar sesión no olvida este navegador si lo marcaste como recordado: para eso usá «Olvidar los dispositivos recordados».</p>
		<form method="POST" action="/admin/salir"><button class="button secondary small">Cerrar sesión</button></form>
	</section>
</div>

<style>
	h1 {
		font-size: var(--step-4);
		text-transform: uppercase;
		margin-bottom: 1.5rem;
	}

	h2 {
		font-size: var(--step-1);
		text-transform: uppercase;
	}

	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(min(100%, 320px), 1fr));
		gap: 1.25rem;
		align-items: start;
		max-width: 1080px;
	}

	.panel {
		display: grid;
		gap: 0.9rem;
		justify-items: start;
	}

	.small {
		font-size: var(--step--1);
	}

	dl {
		display: grid;
		gap: 0.2rem;
		margin: 0;
	}

	dt {
		font-size: var(--step--1);
		color: var(--muted);
	}

	dd {
		margin: 0 0 0.5rem;
		font-weight: 600;
	}

	.email {
		overflow-wrap: anywhere;
	}

	.stack {
		display: grid;
		gap: 1rem;
		justify-items: start;
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.6rem;
	}

	fieldset {
		display: grid;
		gap: 0.6rem;
		margin: 0;
		padding: 0;
		border: 0;
	}
</style>
