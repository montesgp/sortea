<script lang="ts">
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	// The toggle needs JavaScript; without it the field stays masked.
	let enhanced = $state(false);
	let visible = $state(false);
	$effect(() => {
		enhanced = true;
	});
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
			<div class="secret">
				<input id="password" name="password" type={visible ? 'text' : 'password'} autocomplete="current-password" required spellcheck="false" />
				{#if enhanced}
					<button type="button" class="eye" aria-label="Mostrar" aria-controls="password" aria-pressed={visible} title={visible ? 'Ocultar contraseña' : 'Mostrar contraseña'} onclick={() => (visible = !visible)}>
						{#if visible}
							<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3l18 18M10.6 10.6a2 2 0 0 0 2.8 2.8M9.9 5.1A9.8 9.8 0 0 1 12 5c5 0 8.5 4.2 9.5 7-.4 1.1-1.2 2.5-2.4 3.8M6.1 6.1C4.3 7.4 3 9.3 2.5 12c1 2.8 4.5 7 9.5 7 1.7 0 3.2-.5 4.5-1.2" /></svg>
						{:else}
							<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12C3.5 9.2 7 5 12 5s8.5 4.2 9.5 7c-1 2.8-4.5 7-9.5 7s-8.5-4.2-9.5-7z" /><circle cx="12" cy="12" r="3" /></svg>
						{/if}
					</button>
				{/if}
			</div>
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

	.secret {
		position: relative;
	}

	.secret input {
		width: 100%;
		padding-right: 3.25rem;
	}

	.eye {
		position: absolute;
		inset: 0 0 0 auto;
		display: grid;
		place-items: center;
		width: 3rem;
		color: var(--muted);
		background: transparent;
		border: 0;
		border-radius: var(--radius-sm);
		cursor: pointer;
	}

	.eye:hover,
	.eye[aria-pressed='true'] {
		color: var(--text);
	}

	.eye svg {
		width: 22px;
		height: 22px;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.8;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
</style>
