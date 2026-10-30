<script lang="ts">
	/**
	 * The organization's social networks (S8, feedback 2026-10-18), as set in
	 * the back office. Nothing renders for a network that is not set. The footer
	 * also passes its WhatsApp chat and Google Maps place (S3, S4, feedback
	 * 2026-10-30), so every channel shares one icon-and-label item.
	 */
	let {
		social,
		variant = 'icons',
		whatsapp = null,
		maps = null
	}: {
		social: Partial<Record<'instagram' | 'tiktok' | 'youtube' | 'facebook', string>>;
		variant?: 'icons' | 'buttons';
		whatsapp?: string | null;
		maps?: string | null;
	} = $props();

	const networks = [
		{ key: 'instagram', name: 'Instagram' },
		{ key: 'tiktok', name: 'TikTok' },
		{ key: 'youtube', name: 'YouTube' },
		{ key: 'facebook', name: 'Facebook' }
	] as const;
	type Item = { key: (typeof networks)[number]['key'] | 'whatsapp' | 'maps'; name: string; href: string };
	const present = $derived<Item[]>([
		...networks.flatMap((network) => (social[network.key] ? [{ ...network, href: social[network.key]! }] : [])),
		...(whatsapp ? [{ key: 'whatsapp' as const, name: 'WhatsApp', href: whatsapp }] : []),
		...(maps ? [{ key: 'maps' as const, name: 'Cómo llegar', href: maps }] : [])
	]);
</script>

{#if present.length}
	<ul class="social {variant}">
		{#each present as network (network.key)}
			<li>
				<a href={network.href} rel="noopener noreferrer" target="_blank" class={variant === 'buttons' ? 'button secondary' : undefined}>
					<svg viewBox="0 0 24 24" aria-hidden="true">
						{#if network.key === 'instagram'}
							<rect x="3" y="3" width="18" height="18" rx="5" /><circle cx="12" cy="12" r="4" /><circle cx="17.5" cy="6.5" r="1" class="dot" />
						{:else if network.key === 'tiktok'}
							<path d="M14 3v11.5a3.5 3.5 0 1 1-3.5-3.5" /><path d="M14 3c.5 2.6 2.3 4.4 5 4.8" />
						{:else if network.key === 'youtube'}
							<rect x="2.5" y="5.5" width="19" height="13" rx="4" /><path d="M10 9.2v5.6l4.8-2.8z" class="fill" />
						{:else if network.key === 'facebook'}
							<path d="M14.5 21v-7.5H17l.5-3h-3V8.6c0-.9.3-1.6 1.6-1.6h1.5V4.3A19 19 0 0 0 15.4 4c-2.3 0-3.9 1.4-3.9 4v2.5H9v3h2.5V21" />
						{:else if network.key === 'whatsapp'}
							<path d="M3.5 20.5l1.2-4.1a8.6 8.6 0 1 1 3.1 3z" /><path d="M9.2 8.3c-.2 2.9 3.4 6.6 6.5 6.5l.9-1.5-2-1.2-.9.8a5 5 0 0 1-2.6-2.6l.8-.9-1.2-2z" />
						{:else}
							<!-- Location pin, as Google Maps marks a place. -->
							<path d="M12 21.5s-6.8-5.9-6.8-11.6a6.8 6.8 0 0 1 13.6 0c0 5.7-6.8 11.6-6.8 11.6z" /><circle cx="12" cy="9.9" r="2.5" />
						{/if}
					</svg>
					<span>{network.name}</span>
				</a>
			</li>
		{/each}
	</ul>
{/if}

<style>
	.social {
		display: flex;
		flex-wrap: wrap;
		gap: 0.6rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.social a {
		display: inline-flex;
		align-items: center;
		gap: 0.45rem;
	}

	.icons a {
		min-height: 40px;
		padding: 0.35rem 0.6rem 0.35rem 0.4rem;
		border-radius: var(--radius-sm);
		text-decoration: none;
		font-weight: 600;
		font-size: var(--step--1);
	}

	.icons a:hover {
		background: var(--surface-2);
	}

	svg {
		width: 22px;
		height: 22px;
		flex: none;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.8;
		stroke-linecap: round;
		stroke-linejoin: round;
	}

	svg .dot,
	svg .fill {
		fill: currentColor;
		stroke: none;
	}
</style>
