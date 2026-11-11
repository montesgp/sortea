<script lang="ts">
	// Each step updates the page in place instead of reloading it (feedback 2026-10-19).
	import { enhance } from '$app/forms';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const enrollment = $derived(form && 'enrollment' in form ? form.enrollment : null);
	// The code field follows a new QR, a confirmed app, or a code that was refused.
	const askCode = $derived(Boolean(enrollment) || data.confirmed || Boolean(form && 'retry' in form));
	const verified = $derived(data.assurance === 'mfa');
</script>

<svelte:head>
	<title>Verificación en dos pasos</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<main id="contenido" class="mfa">
	<div class="panel">
		<h1>Verificación en dos pasos</h1>
		{#if form?.message}<p class="notice error" role="alert">{form.message}</p>{/if}

		{#if verified}
			<p class="notice ok">Tu sesión ya está verificada.</p>
			<a class="button" href="/admin">Ir al panel</a>
		{:else if enrollment}
			<p>Escaneá el código con tu app de autenticación (Google Authenticator, 1Password, Authy) e ingresá el código que muestra.</p>
			<img class="qr" src={enrollment.qr} alt="Código QR para la app de autenticación" width={enrollment.qrSize} height={enrollment.qrSize} />
			<p class="muted small">¿No podés escanear? Clave manual: <span class="hash">{enrollment.secret}</span></p>
		{:else if !data.confirmed}
			<p>El panel maneja pagos y datos personales, así que pedimos un segundo factor. Configuralo una sola vez.</p>
			<form method="POST" action="?/enroll" use:enhance><button class="button">Configurar app de autenticación</button></form>
		{:else}
			<p>Ingresá el código de 6 dígitos de tu app de autenticación.</p>
		{/if}

		{#if !verified && askCode}
			<form method="POST" action="?/verify" class="verify" use:enhance>
				<div class="field">
					<label for="code">Código</label>
					<input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required />
				</div>
				<div class="remember">
					<label class="check"><input type="checkbox" name="remember" value="yes" /> Recordar este dispositivo por 30 días</label>
					<p class="muted small">En este navegador te vamos a pedir solo la contraseña. No lo marques en un equipo compartido.</p>
				</div>
				<button class="button">Verificar</button>
			</form>
			{#if !data.confirmed}
				<form method="POST" action="?/cancel" class="verify" use:enhance><button class="button quiet">Cancelar</button></form>
			{/if}
		{/if}

		<footer class="exit">
			{#if data.required && !verified}
				<p class="muted small">Tu organización exige este paso para usar el panel.</p>
			{:else if !verified}
				<a class="small" href="/admin">Volver al panel</a>
			{/if}
			<form method="POST" action="/admin/salir"><button class="button quiet small">Cerrar sesión</button></form>
		</footer>
	</div>
</main>

<style>
	.mfa {
		min-height: 100dvh;
		display: grid;
		place-items: center;
		padding: 1rem;
	}

	.panel {
		width: min(100%, 460px);
		display: grid;
		gap: 1rem;
		justify-items: start;
	}

	h1 {
		font-size: var(--step-3);
		text-transform: uppercase;
	}

	/* Drawn at its own size on a white quiet zone so it scans in the dark theme too. */
	.qr {
		justify-self: center;
		box-sizing: content-box;
		background: #fff;
		padding: 16px;
		border-radius: 8px;
		image-rendering: pixelated;
	}

	.verify {
		display: grid;
		gap: 1rem;
		width: 100%;
	}

	.small {
		font-size: var(--step--1);
	}

	.remember {
		display: grid;
		gap: 0.25rem;
	}

	.exit {
		display: flex;
		flex-wrap: wrap;
		justify-content: space-between;
		align-items: center;
		gap: 0.75rem;
		width: 100%;
		padding-top: 1rem;
		border-top: 1px solid var(--border);
	}
</style>
