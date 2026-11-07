<script lang="ts">
	import { trackingChannels } from '@sortea/domain';
	import { dateTime } from '#lib/format.js';
	import { trackingChannelLabel } from '#lib/tracking.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const board = $derived(data.board);
	const timezone = $derived(board.campaign.timezone);
	const active = $derived(board.links.filter((link) => !link.archivedAt));
	const archived = $derived(board.links.filter((link) => link.archivedAt));
	const feedback = (target: string) => (form?.target === target ? form : null);
	const draft = $derived(form?.target === 'create' && !form.ok ? form.values : undefined);
	const channelName = (channel: string) => trackingChannelLabel[channel as keyof typeof trackingChannelLabel] ?? channel;

	let copied = $state<string | null>(null);
	async function copy(id: string, url: string) {
		await navigator.clipboard.writeText(url).catch(() => undefined);
		copied = id;
		setTimeout(() => (copied = copied === id ? null : copied), 2000);
	}
</script>

<svelte:head>
	<title>Links de seguimiento | {board.campaign.title}</title>
</svelte:head>

{#snippet message(target: string)}
	{@const result = feedback(target)}
	{#if result}<p class="notice {result.ok ? 'ok' : 'error'}" role={result.ok ? 'status' : 'alert'}>{result.message}</p>{/if}
{/snippet}

<a class="small" href="/admin/campanas/{board.campaign.id}">Volver a {board.campaign.title}</a>
<header class="head">
	<h1>Links de seguimiento</h1>
	<nav class="tabs small" aria-label="Links de seguimiento">
		<a href="/admin/campanas/{board.campaign.id}/links" aria-current="page">Links</a>
		{#if data.session.permissions.includes('dashboard.view')}<a href="/admin/campanas/{board.campaign.id}/links/rendimiento">Rendimiento</a>{/if}
	</nav>
	<p class="muted small">
		Creá un link por cada video y pegalo en la publicación. Cada compra registra los links por los que entró la persona hasta el cierre de la campaña, el {dateTime(
			board.campaign.closesAt,
			timezone
		)}.
	</p>
</header>

{#if board.campaign.takesTouches}
	<section class="panel" aria-labelledby="new-link-title">
		<h2 id="new-link-title">Nuevo link</h2>
		{@render message('create')}
		<form method="POST" action="?/create" class="stack">
			<div class="row">
				<div class="field">
					<label for="link-name">Nombre del video</label>
					<input id="link-name" name="name" required minlength="2" maxlength="80" placeholder="Reel de la moto roja" defaultValue={draft?.name ?? ''} />
				</div>
				<div class="field">
					<label for="link-channel">Red</label>
					<select id="link-channel" name="channel" required>
						{#each trackingChannels as channel (channel)}
							<option value={channel} selected={(draft?.channel ?? 'instagram') === channel}>{trackingChannelLabel[channel]}</option>
						{/each}
					</select>
				</div>
			</div>
			<div class="field">
				<label for="link-note">Nota (opcional)</label>
				<input id="link-note" name="note" maxlength="300" placeholder="Historia del viernes" defaultValue={draft?.note ?? ''} />
			</div>
			<button class="button small">Crear link</button>
		</form>
	</section>
{:else}
	<p class="notice">La campaña ya cerró: sus links no suman visitas nuevas.</p>
{/if}

<section class="panel" aria-labelledby="links-title">
	<h2 id="links-title">Links activos</h2>
	{@render message('archive')}
	{#if active.length === 0}
		<p class="muted small">Todavía no hay links para esta campaña.</p>
	{:else}
		<ul class="links">
			{#each active as link (link.id)}
				<li aria-label={link.name}>
					<div class="link-head">
						<strong>{link.name}</strong>
						<span class="chip neutral">{channelName(link.channel)}</span>
					</div>
					{#if link.note}<p class="muted small">{link.note}</p>{/if}
					<div class="copy">
						<input readonly value={link.url} aria-label="Link de {link.name}" onfocus={(event) => event.currentTarget.select()} />
						<button type="button" class="button small secondary" onclick={() => copy(link.id, link.url)}>{copied === link.id ? 'Copiado' : 'Copiar'}</button>
					</div>
					<p class="muted small">Creado el {dateTime(link.createdAt, timezone, 'short')}. Código {link.code}.</p>
					<form method="POST" action="?/archive">
						<input type="hidden" name="linkId" value={link.id} />
						<button class="button small secondary">Archivar</button>
					</form>
				</li>
			{/each}
		</ul>
	{/if}
</section>

{#if archived.length}
	<section class="panel" aria-labelledby="archived-title">
		<h2 id="archived-title">Archivados</h2>
		<p class="muted small">Un link archivado no suma visitas nuevas y su código no se vuelve a usar.</p>
		<ul class="links">
			{#each archived as link (link.id)}
				<li aria-label={link.name}>
					<div class="link-head">
						<strong>{link.name}</strong>
						<span class="chip neutral">{channelName(link.channel)}</span>
					</div>
					<p class="muted small">Código {link.code}, archivado el {dateTime(link.archivedAt!, timezone, 'short')}.</p>
				</li>
			{/each}
		</ul>
	</section>
{/if}

<style>
	.head {
		margin: 0.75rem 0 1.25rem;
		display: grid;
		gap: 0.4rem;
	}

	h1 {
		font-size: var(--step-4);
		text-transform: uppercase;
	}

	h2 {
		font-size: var(--step-1);
		text-transform: uppercase;
	}

	.tabs {
		display: flex;
		gap: 1rem;
	}

	.tabs [aria-current='page'] {
		font-weight: 700;
		text-decoration: none;
	}

	.panel {
		margin-block: 1rem;
		display: grid;
		gap: 0.75rem;
	}

	.row {
		display: grid;
		grid-template-columns: 2fr 1fr;
		gap: 0.9rem;
	}

	@media (max-width: 640px) {
		.row {
			grid-template-columns: 1fr;
		}
	}

	.copy input {
		font-family: ui-monospace, Consolas, monospace;
		font-size: 0.8rem;
	}

	.links {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 0.75rem;
	}

	.links li {
		display: grid;
		gap: 0.5rem;
		padding: 1rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		background: var(--surface-2);
	}

	.link-head {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 0.5rem;
	}

	.copy {
		display: flex;
		gap: 0.5rem;
		align-items: center;
	}

	.copy input {
		flex: 1;
		min-width: 0;
	}
</style>
