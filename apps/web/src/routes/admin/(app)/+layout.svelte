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
			{ href: '/admin/conciliacion', label: 'Conciliación', show: can('finance.view') },
			{ href: '/admin/auditoria', label: 'Auditoría', show: can('audit.view') },
			{ href: '/admin/plataforma', label: 'Plataforma', show: data.session.role === 'platform_superadmin' }
		].filter((link) => link.show)
	);
	const current = (href: string) => (href === '/admin' ? page.url.pathname === '/admin' : page.url.pathname.startsWith(href));
</script>

<svelte:head>
	<meta name="robots" content="noindex" />
</svelte:head>

<div class="shell">
	<aside class="sidebar">
		<p class="org">{data.session.organization.name}</p>
		<nav aria-label="Panel">
			<ul>
				{#each links as link (link.href)}
					<li><a href={link.href} aria-current={current(link.href) ? 'page' : undefined}>{link.label}</a></li>
				{/each}
			</ul>
		</nav>
		<div class="me">
			<p class="small">{data.session.user.email}</p>
			<p class="small muted">{roleLabel[data.session.role] ?? data.session.role}{data.session.user.aal === 'aal2' ? ', verificado' : ''}</p>
			{#if data.session.user.aal !== 'aal2'}<a class="small" href="/admin/mfa">Activar verificación en dos pasos</a>{/if}
			<form method="POST" action="/admin/salir"><button class="button quiet small logout">Cerrar sesión</button></form>
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

	.org {
		font: 800 var(--step-2) / 1 var(--font-display);
		text-transform: uppercase;
		padding-inline: 0.75rem;
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

	.me {
		margin-top: auto;
		display: grid;
		gap: 0.25rem;
		padding-inline: 0.75rem;
		overflow-wrap: anywhere;
	}

	.small {
		font-size: var(--step--1);
	}

	.logout {
		padding-inline: 0;
		justify-content: flex-start;
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
