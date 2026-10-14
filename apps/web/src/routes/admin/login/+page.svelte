<script lang="ts">
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
</script>

<svelte:head>
	<title>Ingresar al panel</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<main id="contenido" class="login">
	<form method="POST" class="panel">
		<p class="muted">{data.site?.organization.name ?? 'Plataforma'}</p>
		<h1>Panel de gestión</h1>
		{#if form?.message}<p class="notice error" role="alert">{form.message}</p>{/if}
		<div class="field">
			<label for="email">Email</label>
			<input id="email" name="email" type="email" autocomplete="username" required defaultValue={form?.email ?? ''} />
		</div>
		<div class="field">
			<label for="password">Contraseña</label>
			<input id="password" name="password" type="password" autocomplete="current-password" required />
		</div>
		<button class="button">Ingresar</button>
		<p class="muted small">El acceso lo otorga el equipo de la plataforma. No hay registro abierto.</p>
	</form>
</main>

<style>
	.login {
		min-height: 100dvh;
		display: grid;
		place-items: center;
		padding: 1rem;
	}

	form {
		width: min(100%, 400px);
		display: grid;
		gap: 1rem;
	}

	h1 {
		font-size: var(--step-3);
		text-transform: uppercase;
	}

	.small {
		font-size: var(--step--1);
	}
</style>
