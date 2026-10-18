<script lang="ts">
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const enrollment = $derived(form && 'enrollment' in form ? form.enrollment : null);
	const factorId = $derived(enrollment?.factorId ?? data.verified?.id ?? (form && 'retryFactorId' in form ? form.retryFactorId : null));
</script>

<svelte:head>
	<title>Verificación en dos pasos</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<main id="contenido" class="mfa">
	<div class="panel">
		<h1>Verificación en dos pasos</h1>
		{#if form?.message}<p class="notice error" role="alert">{form.message}</p>{/if}

		{#if data.aal === 'aal2'}
			<p class="notice ok">Tu sesión ya está verificada.</p>
			<a class="button" href="/admin">Ir al panel</a>
		{:else if enrollment}
			<p>Escaneá el código con tu app de autenticación (Google Authenticator, 1Password, Authy) e ingresá el código que muestra.</p>
			<img class="qr" src={enrollment.qr} alt="Código QR para la app de autenticación" width={enrollment.qrSize} height={enrollment.qrSize} />
			<p class="muted small">¿No podés escanear? Clave manual: <span class="hash">{enrollment.secret}</span></p>
		{:else if !data.verified}
			<p>El panel maneja pagos y datos personales, así que pedimos un segundo factor. Configuralo una sola vez.</p>
			<form method="POST" action="?/enroll"><button class="button">Configurar app de autenticación</button></form>
		{:else}
			<p>Ingresá el código de 6 dígitos de tu app de autenticación.</p>
		{/if}

		{#if data.aal !== 'aal2' && factorId}
			<form method="POST" action="?/verify" class="verify">
				<input type="hidden" name="factorId" value={factorId} />
				<div class="field">
					<label for="code">Código</label>
					<input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required />
				</div>
				<button class="button">Verificar</button>
			</form>
			{#if !data.verified}
				<form method="POST" action="?/cancel" class="verify"><button class="button quiet">Cancelar</button></form>
			{/if}
		{/if}

		<footer class="exit">
			{#if data.required && data.aal !== 'aal2'}
				<p class="muted small">Tu organización exige este paso para usar el panel.</p>
			{:else if data.aal !== 'aal2'}
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
