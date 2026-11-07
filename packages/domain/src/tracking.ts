import { z } from 'zod';
import type { CampaignStatus } from './campaign';

/**
 * Tracking links per video (odd/tasks/tracking-links.md). Social networks do not tell the
 * site which video a visitor watched: only a link of its own identifies a video (S5). Each
 * link belongs to a campaign; a visit through it is a touch, remembered in a first-party
 * cookie until that campaign closes (S2), and a purchase records every valid touch, marking
 * the most recent one as the last (S3). Attribution never changes prices or chances.
 */
export const trackingChannels = ['instagram', 'facebook', 'tiktok', 'youtube', 'whatsapp', 'other'] as const;
export type TrackingChannel = (typeof trackingChannels)[number];
export const trackingChannelSchema = z.enum(trackingChannels);

/** Codes are generated (see `generateTrackingCode`): 8 lowercase letters and digits, safe in any URL. */
export const trackingCodeSchema = z.string().regex(/^[a-z0-9]{8}$/);

/** Touches a visitor's cookie remembers, and a checkout forwards, at most. */
export const MAX_TRACKING_TOUCHES = 10;

/** What the back office types to create a link: the video's name, its network and an optional note. */
export const trackingLinkInputSchema = z.object({
	name: z.string().trim().min(2).max(80),
	channel: trackingChannelSchema,
	note: z
		.string()
		.trim()
		.max(300)
		.optional()
		.transform((note) => note || undefined)
});
export type TrackingLinkInput = z.infer<typeof trackingLinkInputSchema>;

export const trackingTouchSchema = z.object({ code: trackingCodeSchema, at: z.coerce.date() });
export type TrackingTouch = z.infer<typeof trackingTouchSchema>;

/** Sent by the web with a checkout: the visitor's touches and, for purchases without a link, the network guessed from the referrer. */
export const attributionSchema = z.object({
	touches: z.array(trackingTouchSchema).max(MAX_TRACKING_TOUCHES).default([]),
	channel: trackingChannelSchema.optional()
});
export type Attribution = z.infer<typeof attributionSchema>;

/** A campaign takes touches until it closes: neither after its closing time nor once it moved to closed or later. */
export function campaignTakesTouches(campaign: { status: CampaignStatus; closesAt: Date }, now: Date): boolean {
	return ['draft', 'review', 'published', 'open'].includes(campaign.status) && campaign.closesAt.getTime() > now.getTime();
}

export interface AttributableLink {
	id: string;
	code: string;
	createdAt: Date;
	archivedAt: Date | null;
	campaign: { status: CampaignStatus; closesAt: Date };
}

export interface AttributionRow {
	trackingLinkId: string;
	touchedAt: Date;
	isLast: boolean;
}

/** Clock difference tolerated between the web, where a touch is timed, and the API. */
const CLOCK_SKEW_MS = 5 * 60_000;

/**
 * The attribution rows of an order placed `now` (S3). `links` are the organization's links
 * named by the touches. A touch counts when its link is active and its campaign still takes
 * touches, and its time falls within the link's life; anything else (a foreign, archived or
 * tampered code) is dropped silently. One row per link at its latest touch, oldest first;
 * the most recent is the last.
 */
export function selectAttribution(touches: readonly TrackingTouch[], links: readonly AttributableLink[], now: Date): AttributionRow[] {
	const byCode = new Map(links.map((link) => [link.code, link]));
	const latest = new Map<string, Date>();
	for (const touch of touches) {
		const link = byCode.get(touch.code);
		if (!link || link.archivedAt || !campaignTakesTouches(link.campaign, now)) continue;
		const time = touch.at.getTime();
		if (time < link.createdAt.getTime() - CLOCK_SKEW_MS || time > now.getTime() + CLOCK_SKEW_MS) continue;
		const touchedAt = new Date(Math.min(time, now.getTime()));
		const previous = latest.get(link.id);
		if (!previous || touchedAt > previous) latest.set(link.id, touchedAt);
	}
	const rows = [...latest].map(([trackingLinkId, touchedAt]) => ({ trackingLinkId, touchedAt })).sort((a, b) => a.touchedAt.getTime() - b.touchedAt.getTime());
	return rows.map((row, index) => ({ ...row, isLast: index === rows.length - 1 }));
}
