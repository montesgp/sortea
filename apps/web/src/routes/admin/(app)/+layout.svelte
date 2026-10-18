<script lang="ts">
	import { page } from '$app/state';
	import type { LayoutProps } from './$types';

	let { data, children }: LayoutProps = $props();
	const can = (permission: string) => data.session.permissions.includes(permission);
	const roleLabel: Record<string, string> = {
		platform_superadmin: 'Plataforma',
		org_owner: 'Dueño',
		org_admin: 'Administración',
		finance_manager: 'Finanzas',
		campaign_operator: 'Operación',
		auditor: 'Auditoría',
		support_agent: 'Atención'
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
	const verified = $derived(data.session.user.aal === 'aal2');
	const current = (href: string) => (href === '/admin' ? page.url.pathname === '/admin' : page.url.pathname.startsWith(href));
</script>

<svelte:head>
	<meta name="robots" content="noindex" />
</svelte:head>

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
					<li><a href="/admin/plataforma" aria-current={current('/admin/plataforma') ? 'page' : undefined}>Organizaciones</a></li>
				</ul>
			{/if}
		</nav>
		<div class="me">
			<div class="who">
				<span class="avatar" aria-hidden="true">{email.charAt(0).toUpperCase()}</span>
				<div class="id">
					<p class="email" title={email}>{email}</p>
					<p class="role">{roleLabel[data.session.role] ?? data.session.role}</p>
				</div>
			</div>
			<a class="action two-step" href="/admin/mfa">
				Verificación en dos pasos
				<span class="state" class:on={verified}>{verified ? 'Activa' : 'Pendiente'}</span>
			</a>
			<form method="POST" action="/admin/salir"><button class="action">Cerrar sesión</button></form>
		</div>
	</aside>
	<main id="contenido" class="content">
		{@render children()}
	</main>
</div>

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

	/* Who is signed in, then one action per row: nothing crowded at the bottom. */
	.me {
		margin-top: auto;
		display: grid;
		gap: 0.25rem;
		padding-top: 1rem;
		border-top: 1px solid var(--border);
	}

	.who {
		display: flex;
		align-items: center;
		gap: 0.65rem;
		padding: 0 0.75rem 0.5rem;
		min-width: 0;
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
		min-width: 0;
	}

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

	.action {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
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

	.action:hover {
		background: var(--surface-2);
	}

	.two-step {
		display: grid;
		justify-content: stretch;
		gap: 0.1rem;
	}

	.state {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		font-size: 0.75rem;
		font-weight: 600;
		color: var(--warning, #e0a43a);
	}

	.state::before {
		content: '';
		width: 0.45rem;
		height: 0.45rem;
		border-radius: 50%;
		background: currentColor;
	}

	.state.on {
		color: var(--success);
	}

	.content {
		padding: clamp(1.25rem, 1rem + 2vw, 2.5rem);
		min-width: 0;
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
