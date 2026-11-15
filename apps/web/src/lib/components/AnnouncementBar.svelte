<script lang="ts">
	import { dateTime } from '#lib/format.js';
	import type { ClosingCampaign, SiteData } from '#lib/server/types.js';

	/**
	 * The strip above every page. With its option on and a campaign accepting
	 * participations, it invites to the one closing first and links to the shop
	 * (owner feedback 2026-11-15 S3); otherwise it shows its own text when on.
	 */
	let {
		announcement,
		closingCampaign = null,
		timezone
	}: { announcement: SiteData['content']['announcement']; closingCampaign?: ClosingCampaign | null; timezone: string } = $props();
	const campaign = $derived(announcement?.showClosingCampaign ? closingCampaign : null);
	const external = $derived(announcement?.linkUrl?.startsWith('https://') ?? false);
</script>

{#if campaign}
	<aside class="announcement campaign" aria-label="Aviso">
		<div class="container">
			<p>
				<span class="dot" aria-hidden="true"></span>
				Participaciones abiertas para {campaign.title} hasta el {dateTime(campaign.closesAt, timezone)}
				<a href="/tienda">Participá</a>
			</p>
		</div>
	</aside>
{:else if announcement?.enabled}
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

	/* The campaign's call to act: the link reads as a button. */
	.campaign a {
		display: inline-block;
		padding: 0.1rem 0.7rem;
		border-radius: 999px;
		background: var(--accent-text);
		color: var(--accent);
		text-decoration: none;
	}

	.dot {
		display: inline-block;
		width: 0.5rem;
		height: 0.5rem;
		margin-right: 0.35rem;
		border-radius: 50%;
		background: currentColor;
		vertical-align: 0.05em;
	}

	@media (prefers-reduced-motion: no-preference) {
		.dot {
			animation: breathe 1.6s ease-in-out infinite;
		}
	}

	@keyframes breathe {
		50% {
			opacity: 0.35;
		}
	}
</style>
