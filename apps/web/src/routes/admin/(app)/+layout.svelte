<script lang="ts">
	import { page } from '$app/state';
	import type { LayoutProps } from './$types';

	let { data, children }: LayoutProps = $props();
	const can = (permission: string) => data.session.permissions.includes(permission);
	const roleLabel: Record<string, string> = {
		platform_superadmin: 'Sysadmin (plataforma)',
		org_owner: 'Dueño',
		org_admin: 'Administración',
		finance_manager: 'Finanzas',
		campaign_operator: 'Operación',
		auditor: 'Auditoría',
		support_agent: 'Atención',
		draw_host: 'Conductor del sorteo'
	};
	const links = $derived(
		[
			{ href: '/admin', label: 'Resumen', show: can('dashboard.view') },
			{ href: '/admin/pedidos', label: 'Pedidos', show: can('orders.view') },
			{ href: '/admin/campanas', label: 'Campañas', show: can('campaigns.view') },
			{ href: '/admin/productos', label: 'Productos', show: can('campaigns.view') },
			{ href: '/admin/sitio', label: 'Sitio', show: can('cms.manage') },
			{ href: '/admin/conciliacion', label: 'Conciliación', show: can('finance.view') },
			{ href: '/admin/auditoria', label: 'Auditoría', show: can('audit.view') },
			{ href: '/admin/configuracion', label: 'Configuración', show: can('settings.manage') }
		].filter((link) => link.show)
	);
	// Platform staff manage every organization; this panel shows the one of the current domain.
	const platform = $derived(data.session.role === 'platform_superadmin');
	const email = $derived(data.session.user.email);
	// The alias names the user when the account has one; the email is always shown too.
	const alias = $derived(data.session.user.alias?.trim() || null);
	const verified = $derived(data.session.user.assurance === 'mfa');
	const current = (href: string) => (href === '/admin' ? page.url.pathname === '/admin' : page.url.pathname.startsWith(href));
	// The draw host's panel is the draw room only (odd/tasks/draw-room.md T5, S3): the brand, the campaign, its account and sign out.
	const roomCampaign = $derived((page.data as { room?: { campaign?: { title?: string } } }).room?.campaign?.title ?? null);
	// The room's broadcast mode renders nothing of the panel around it: no account, menus or email on air.
	const onAir = $derived(page.url.pathname.startsWith('/admin/sala-de-sorteo/') && page.url.searchParams.has('transmision'));
</script>

<svelte:head>
	<meta name="robots" content="noindex" />
</svelte:head>

{#if onAir}
	<main id="contenido">
		{@render children()}
	</main>
{:else if data.drawRoomOnly}
	<div class="room-shell">
		<header class="room-bar">
			<a class="room-brand" href="/admin/sala-de-sorteo">
				<span class="eyebrow">Sala de sorteo</span>
				<span class="org">{data.session.organization.name}</span>
			</a>
			{#if roomCampaign}<p class="room-campaign">{roomCampaign}</p>{/if}
			<nav class="room-actions" aria-label="Cuenta">
				<a class="action" href="/admin/cuenta" aria-current={current('/admin/cuenta') ? 'page' : undefined}>Mi cuenta</a>
				<form method="POST" action="/admin/salir"><button class="action">Salir</button></form>
			</nav>
		</header>
		<main id="contenido" class="content">
			{@render children()}
		</main>
	</div>
{:else}
<div class="shell">
	<aside class="sidebar">
		<div class="brand">
			<p class="eyebrow">{platform ? 'Organización' : 'Panel'}</p>
			<p class="org">{data.session.organization.name}</p>
		</div>
		<nav aria-label="Panel">
			<ul>
				{#each links as link (link.href)}
					<li><a href={link.href} aria-current={current(link.href) ? 'page' : undefined}>{link.label}</a></li>
				{/each}
			</ul>
			{#if platform}
				<p class="group" id="nav-platform">Plataforma</p>
				<ul aria-labelledby="nav-platform">
					<li><a href="/admin/plataforma" aria-current={current('/admin/plataforma') && !current('/admin/plataforma/usuarios') ? 'page' : undefined}>Organizaciones</a></li>
					<li><a href="/admin/plataforma/usuarios" aria-current={current('/admin/plataforma/usuarios') ? 'page' : undefined}>Usuarios</a></li>
				</ul>
			{/if}
		</nav>
		<!-- Everything about the signed-in user lives in one place (owner feedback 2026-11-10 S11). -->
		<details class="account">
			<summary>
				<span class="avatar" aria-hidden="true">{(alias ?? email).charAt(0).toUpperCase()}</span>
				<span class="id">
					<span class="name" title={alias ?? email}>{alias ?? email}</span>
					<span class="role" title={platform ? 'Accede a todas las organizaciones y a la consola de plataforma' : undefined}>{roleLabel[data.session.role] ?? data.session.role}</span>
				</span>
				<span class="state" class:on={verified} title={verified ? 'Verificación en dos pasos activa' : 'Verificación en dos pasos pendiente'}>
					<span class="visually-hidden">{verified ? 'Verificación en dos pasos activa' : 'Verificación en dos pasos pendiente'}</span>
				</span>
			</summary>
			<div class="menu">
				{#if alias}<p class="email" title={email}>{email}</p>{/if}
				<a class="action" href="/admin/cuenta" aria-current={current('/admin/cuenta') ? 'page' : undefined}>Mi cuenta</a>
				<form method="POST" action="/admin/salir"><button class="action">Cerrar sesión</button></form>
			</div>
		</details>
	</aside>
	<main id="contenido" class="content">
		{#if data.session.organization.status === 'suspended'}
			<p class="notice error suspended" role="status">Organización suspendida: su sitio público está pausado y no vende. Solo el equipo de plataforma entra a este panel.</p>
		{/if}
		{@render children()}
	</main>
</div>
{/if}

<style>
	.shell {
		display: grid;
		grid-template-columns: 232px minmax(0, 1fr);
		min-height: 100dvh;
	}

	.sidebar {
		position: sticky;
		top: 0;
		height: 100dvh;
		display: flex;
		flex-direction: column;
		gap: 2rem;
		padding: 1.5rem 1rem;
		border-right: 1px solid var(--border);
		background: var(--surface);
	}

	.brand {
		display: grid;
		gap: 0.3rem;
		padding-inline: 0.75rem;
	}

	.eyebrow,
	.group {
		font-size: 0.7rem;
		font-weight: 700;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--muted);
	}

	.org {
		font: 800 var(--step-2) / 1 var(--font-display);
		text-transform: uppercase;
		overflow-wrap: anywhere;
	}

	nav {
		display: grid;
		gap: 0.5rem;
	}

	.group {
		margin-top: 0.75rem;
		padding: 0.75rem 0.75rem 0;
		border-top: 1px solid var(--border);
	}

	ul {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 0.2rem;
	}

	nav a {
		display: block;
		padding: 0.6rem 0.75rem;
		border-radius: var(--radius-sm);
		text-decoration: none;
		font-weight: 600;
		font-size: var(--step--1);
	}

	nav a:hover {
		background: var(--surface-2);
	}

	nav a[aria-current='page'] {
		background: var(--surface-2);
		box-shadow: inset 3px 0 0 var(--accent);
	}

	/* The user menu: who is signed in, and the account and sign out once opened. */
	.account {
		margin-top: auto;
		padding-top: 1rem;
		border-top: 1px solid var(--border);
	}

	summary {
		display: flex;
		align-items: center;
		gap: 0.65rem;
		min-height: 44px;
		padding: 0.4rem 0.75rem;
		border-radius: var(--radius-sm);
		cursor: pointer;
		list-style: none;
	}

	summary::-webkit-details-marker {
		display: none;
	}

	summary:hover,
	.account[open] summary {
		background: var(--surface-2);
	}

	/* A chevron says the row opens; it turns when the menu is open. */
	summary::after {
		content: '';
		flex: none;
		width: 0.45rem;
		height: 0.45rem;
		margin-inline-start: 0.1rem;
		border-right: 2px solid var(--muted);
		border-bottom: 2px solid var(--muted);
		rotate: -135deg;
		translate: 0 0.15rem;
	}

	.account[open] summary::after {
		rotate: 45deg;
		translate: 0 -0.1rem;
	}

	.avatar {
		display: grid;
		place-items: center;
		flex: none;
		width: 2.25rem;
		height: 2.25rem;
		border-radius: 50%;
		background: var(--accent);
		color: var(--accent-text);
		font-weight: 800;
	}

	.id {
		display: grid;
		flex: 1;
		min-width: 0;
	}

	.name,
	.email {
		font-size: var(--step--1);
		font-weight: 600;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.role {
		font-size: 0.75rem;
		color: var(--muted);
	}

	/* The second factor's state at a glance; "Mi cuenta" says it in words. */
	.state {
		flex: none;
		width: 0.55rem;
		height: 0.55rem;
		border-radius: 50%;
		background: var(--warning);
	}

	.state.on {
		background: var(--success);
	}

	.menu {
		display: grid;
		gap: 0.25rem;
		padding-top: 0.25rem;
	}

	.email {
		padding: 0.25rem 0.75rem;
		font-weight: 400;
		color: var(--muted);
	}

	.action {
		display: flex;
		align-items: center;
		width: 100%;
		min-height: 40px;
		padding: 0.4rem 0.75rem;
		border: 0;
		border-radius: var(--radius-sm);
		background: transparent;
		color: inherit;
		font: inherit;
		font-size: var(--step--1);
		font-weight: 600;
		text-align: left;
		text-decoration: none;
		cursor: pointer;
	}

	.action:hover,
	.action[aria-current='page'] {
		background: var(--surface-2);
	}

	.action[aria-current='page'] {
		box-shadow: inset 3px 0 0 var(--accent);
	}

	/* The draw host's bar: no sections to go to, only the room, the account and sign out. */
	.room-shell {
		min-height: 100dvh;
		display: grid;
		grid-template-rows: auto 1fr;
	}

	.room-bar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem 1.5rem;
		padding: 0.75rem clamp(1rem, 0.5rem + 2vw, 2.5rem);
		border-bottom: 1px solid var(--border);
		background: var(--surface);
	}

	.room-brand {
		display: grid;
		gap: 0.15rem;
		text-decoration: none;
		color: inherit;
	}

	.room-brand .org {
		font-size: var(--step-1);
	}

	.room-campaign {
		flex: 1;
		min-width: 0;
		font-weight: 700;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.room-actions {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		margin-inline-start: auto;
	}

	.room-actions .action {
		width: auto;
	}

	.content {
		padding: clamp(1.25rem, 1rem + 2vw, 2.5rem);
		min-width: 0;
	}

	.suspended {
		margin-bottom: 1rem;
	}

	@media (max-width: 860px) {
		.shell {
			grid-template-columns: 1fr;
		}

		.sidebar {
			position: static;
			height: auto;
			gap: 1rem;
		}

		ul {
			display: flex;
			flex-wrap: wrap;
		}
	}
</style>
