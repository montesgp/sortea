<script lang="ts">
	import { dateTime } from '#lib/format.js';
	import type { ClosingCampaign, SiteData } from '#lib/server/types.js';

	/**
	 * The strip above every page. With its option on and a campaign accepting
	 * participations, it invites to the one closing first and links to the shop
	 * (owner feedback 2026-11-15 S3), in yellow like the demo strip; otherwise it
	 * shows its own text in the accent color when on (2026-11-15b S3). It shows
	 * only on the devices chosen in the admin (2026-11-15b S5).
	 */
	let {
		announcement,
		closingCampaign = null,
		timezone
	}: { announcement: SiteData['content']['announcement']; closingCampaign?: ClosingCampaign | null; timezone: string } = $props();
	const campaign = $derived(announcement?.showClosingCampaign ? closingCampaign : null);
	const external = $derived(announcement?.linkUrl?.startsWith('https://') ?? false);
	const devices = $derived(announcement?.devices ?? { desktop: true, tablet: true, phone: true });
	const anywhere = $derived(devices.desktop || devices.tablet || devices.phone);
	const hidden = $derived(
		[!devices.desktop && 'hide-desktop', !devices.tablet && 'hide-tablet', !devices.phone && 'hide-phone'].filter(Boolean).join(' ')
	);
</script>

{#if anywhere && campaign}
	<aside class="announcement campaign {hidden}" aria-label="Aviso">
		<div class="container">
			<p>
				<span class="dot" aria-hidden="true"></span>
				Participaciones abiertas para {campaign.title} hasta el {dateTime(campaign.closesAt, timezone)}
				<a href="/tienda">Participá</a>
			</p>
		</div>
	</aside>
{:else if anywhere && announcement?.enabled && announcement.text}
	<aside class="announcement {hidden}" aria-label="Aviso">
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

	/* The campaign invitation is yellow on dark stripes, like the demo strip (2026-11-15b S3). */
	.campaign {
		background: repeating-linear-gradient(-45deg, #231a00 0 14px, #3a2c00 14px 28px);
		color: #ffd75e;
	}

	/* Its call to act reads as a button. */
	.campaign a {
		display: inline-block;
		padding: 0.1rem 0.7rem;
		border-radius: 999px;
		background: #ffd75e;
		color: #231a00;
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

	/* Devices: phones up to 599 px, tablets up to 1023 px, computers from 1024 px. */
	@media (max-width: 599px) {
		.hide-phone {
			display: none;
		}
	}

	@media (min-width: 600px) and (max-width: 1023px) {
		.hide-tablet {
			display: none;
		}
	}

	@media (min-width: 1024px) {
		.hide-desktop {
			display: none;
		}
	}
</style>
