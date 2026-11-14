<script lang="ts">
	import { dateTime } from '#lib/format.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const created = $derived(form && 'created' in form ? form.created : null);
	// The alias forms of the list and the creation form answer in their own place.
	const aliasResult = $derived(form && 'aliasOf' in form ? form : null);
	const createError = $derived(form && !('aliasOf' in form) && 'message' in form ? form : null);
	const aliasValue = (user: { id: string; alias: string | null }) => (aliasResult?.aliasOf === user.id && !aliasResult.ok ? aliasResult.alias : (user.alias ?? ''));
	const roleLabel: Record<string, string> = {
		org_owner: 'Dueño',
		org_admin: 'Administración',
		finance_manager: 'Finanzas',
		campaign_operator: 'Operación',
		auditor: 'Auditoría',
		support_agent: 'Atención',
		draw_host: 'Conductor del sorteo'
	};
	const sysadminHint = 'Accede a todas las organizaciones y a la consola de plataforma';
	// Accounts span organizations: their sign-ins are shown in the zone of the platform's own organization.
	const date = (value: string | null) => (value ? dateTime(value, data.session.organization.timezone) : 'Nunca');
</script>

<svelte:head>
	<title>Usuarios | Panel</title>
</svelte:head>

<h1>Usuarios</h1>
<p class="muted small">Cuentas del panel de todas las organizaciones. Para dar una contraseña nueva, quitar la app de autenticación o desactivar una cuenta se usa <span class="hash">pnpm admin:user</span>.</p>
<p class="muted small">Sysadmin (plataforma): {sysadminHint.toLowerCase()}.</p>

<div class="table-wrap">
	<table>
		<thead><tr><th scope="col">Email</th><th scope="col">Alias</th><th scope="col">Acceso</th><th scope="col">Estado</th><th scope="col">Dos pasos</th><th scope="col">Último ingreso</th></tr></thead>
		<tbody>
			{#each data.users as user (user.id)}
				<tr>
					<td class="email">{user.email}</td>
					<td>
						<form method="POST" action="?/alias" class="alias">
							<input type="hidden" name="id" value={user.id} />
							<input name="alias" maxlength="60" autocomplete="off" aria-label="Alias de {user.email}" placeholder="Sin alias" defaultValue={aliasValue(user)} />
							<button class="button small secondary">Guardar</button>
						</form>
						{#if aliasResult?.aliasOf === user.id}<p class="small {aliasResult.ok ? 'ok' : 'error'}" role={aliasResult.ok ? 'status' : 'alert'}>{aliasResult.message}</p>{/if}
					</td>
					<td class="small">
						{#if user.platformAdmin}<span class="chip" title={sysadminHint}>Sysadmin (plataforma)</span>{/if}
						{user.organizations.map((org) => `${org.name} (${roleLabel[org.role] ?? org.role})`).join(', ')}
					</td>
					<td><span class="chip {user.status === 'active' ? 'ok' : 'bad'}">{user.status === 'active' ? (user.mustChangePassword ? 'Contraseña temporal' : 'Activa') : 'Desactivada'}</span></td>
					<td class="small">{user.mfa ? 'Activa' : 'Pendiente'}</td>
					<td class="small">{date(user.lastSignInAt)}</td>
				</tr>
			{/each}
		</tbody>
	</table>
</div>

<section class="panel create" aria-labelledby="create-title">
	<h2 id="create-title">Nuevo usuario</h2>
	{#if createError}<p class="notice error" role="alert">{createError.message}</p>{/if}
	{#if created}
		<div class="notice ok" role="status">
			<p>Creamos la cuenta de {created.alias ? `${created.alias} (${created.email})` : created.email}.</p>
			<p>Contraseña temporal (se muestra una sola vez): <span class="hash">{created.temporaryPassword}</span></p>
			<p class="small">Pasásela por un canal privado. Al ingresar, el panel le pide elegir una propia. Para que sea dueña de una organización nueva, escribí su email al crear la organización.</p>
		</div>
	{/if}
	<form method="POST" action="?/create" class="create-form">
		<div class="field email-field">
			<label for="email">Email</label>
			<input id="email" name="email" type="email" required autocomplete="off" placeholder="nombre.apellido@empresa.com.ar" defaultValue={createError && 'email' in createError ? createError.email : ''} />
		</div>
		<div class="field alias-field">
			<label for="alias">Alias <span class="muted">(opcional)</span></label>
			<input id="alias" name="alias" maxlength="60" autocomplete="off" aria-describedby="alias-hint" defaultValue={createError && 'alias' in createError ? createError.alias : ''} />
			<p class="hint" id="alias-hint">Un nombre corto para reconocerla en las listas, hasta 60 caracteres.</p>
		</div>
		<div class="field">
			<label class="check"><input type="checkbox" name="platformAdmin" aria-describedby="sysadmin-hint" /> Sysadmin (plataforma)</label>
			<p class="hint" id="sysadmin-hint">{sysadminHint}.</p>
		</div>
		<button class="button">Crear usuario</button>
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

	td.email {
		overflow-wrap: anywhere;
	}

	.alias {
		display: flex;
		gap: 0.4rem;
		align-items: center;
	}

	.alias input {
		width: 12rem;
		min-width: 0;
	}

	td .ok {
		color: var(--success);
	}

	td .error {
		color: var(--danger);
	}

	/* The email field fits a typical full address (S3, feedback 2026-11-10). */
	.create-form {
		display: flex;
		flex-wrap: wrap;
		gap: 1rem;
		align-items: start;
	}

	.email-field {
		flex: 1 1 26rem;
		max-width: 36rem;
	}

	.alias-field {
		flex: 1 1 14rem;
		max-width: 22rem;
	}

	.create-form input:not([type='checkbox']) {
		width: 100%;
	}

	.check {
		display: flex;
		gap: 0.5rem;
		align-items: center;
		min-height: 44px;
	}

	.create-form .button {
		flex-basis: 100%;
		max-width: max-content;
	}
</style>
