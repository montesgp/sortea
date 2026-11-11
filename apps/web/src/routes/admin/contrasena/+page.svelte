<script lang="ts">
	import PasswordInput from '#lib/components/PasswordInput.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
</script>

<svelte:head>
	<title>Cambiar contraseña</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<main id="contenido" class="password">
	<div class="panel">
		<h1>Cambiar contraseña</h1>
		{#if data.required}
			<p>Tu contraseña es temporal. Elegí una propia para usar el panel.</p>
		{/if}
		{#if form?.message}<p class="notice {form.ok ? 'ok' : 'error'}" role={form.ok ? 'status' : 'alert'}>{form.message}</p>{/if}
		<form method="POST" class="stack">
			<input type="text" name="username" autocomplete="username" value={data.email} hidden readonly />
			<div class="field">
				<label for="currentPassword">{data.required ? 'Contraseña temporal' : 'Contraseña actual'}</label>
				<PasswordInput id="currentPassword" name="currentPassword" label={data.required ? 'Contraseña temporal' : 'Contraseña actual'} autocomplete="current-password" required />
			</div>
			<div class="field">
				<label for="newPassword">Contraseña nueva</label>
				<PasswordInput id="newPassword" name="newPassword" label="Contraseña nueva" autocomplete="new-password" minlength={12} maxlength={200} required describedby="new-hint" />
				<p class="hint" id="new-hint">Al menos 12 caracteres. Al cambiarla se cierran tus otras sesiones.</p>
			</div>
			<div class="field">
				<label for="confirmPassword">Repetí la contraseña nueva</label>
				<PasswordInput id="confirmPassword" name="confirmPassword" label="Repetí la contraseña nueva" autocomplete="new-password" minlength={12} maxlength={200} required />
			</div>
			<button class="button">Cambiar contraseña</button>
		</form>
		<footer class="exit">
			{#if !data.required}<a class="small" href="/admin">Volver al panel</a>{/if}
			<form method="POST" action="/admin/salir"><button class="button quiet small">Cerrar sesión</button></form>
		</footer>
	</div>
</main>

<style>
	.password {
		min-height: 100dvh;
		display: grid;
		place-items: center;
		padding: 1rem;
	}

	.panel {
		width: min(100%, 460px);
		display: grid;
		gap: 1rem;
	}

	h1 {
		font-size: var(--step-3);
		text-transform: uppercase;
	}

	.stack {
		display: grid;
		gap: 1rem;
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
		padding-top: 1rem;
		border-top: 1px solid var(--border);
	}
</style>
