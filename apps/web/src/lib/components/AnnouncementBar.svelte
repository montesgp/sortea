<script lang="ts">
	import type { SiteData } from '#lib/server/types.js';

	let { announcement }: { announcement: SiteData['content']['announcement'] } = $props();
	const external = $derived(announcement?.linkUrl?.startsWith('https://') ?? false);
</script>

{#if announcement?.enabled}
	<aside class="announcement" aria-label="Aviso">
		<div class="container">
			<p>
				{announcement.text}
				{#if announcement.linkUrl}
					<a href={announcement.linkUrl} rel={external ? 'noopener' : undefined} target={external ? '_blank' : undefined}>{announcement.linkLabel || 'Ver más'}</a>
				{/if}
			</p>
		</div>
	</aside>
{/if}

<style>
	.announcement {
		background: var(--accent);
		color: var(--accent-text);
		font-weight: 600;
		font-size: var(--step--1);
	}

	p {
		margin: 0;
		padding-block: 0.55rem;
		text-align: center;
	}

	a {
		color: inherit;
		margin-left: 0.4rem;
		text-decoration: underline;
		text-underline-offset: 0.2em;
	}
</style>
