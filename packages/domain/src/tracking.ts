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

/**
 * A campaign takes touches until it closes: neither after its closing time nor once it moved to closed or later.
 * A draft still without a closing date takes none: a link needs to know until when it counts.
 */
export function campaignTakesTouches(campaign: { status: CampaignStatus; closesAt: Date | null }, now: Date): boolean {
	return ['draft', 'review', 'published', 'open'].includes(campaign.status) && campaign.closesAt !== null && campaign.closesAt.getTime() > now.getTime();
}

export interface AttributableLink {
	id: string;
	code: string;
	createdAt: Date;
	archivedAt: Date | null;
	campaign: { status: CampaignStatus; closesAt: Date | null };
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

/**
 * A paid purchase as the performance report reads it (S4): who bought (an internal contact
 * id, never shown), the eligible chances it holds, its total, the net Mercado Pago reported
 * for it (null while the fees are unknown), the network guessed for a purchase without a link
 * and the links it is attributed to, oldest touch first.
 */
export interface PerformanceOrder {
	contactId: string;
	chances: number;
	grossMinor: number;
	netMinor: number | null;
	sourceChannel: TrackingChannel | null;
	links: readonly { linkId: string; isLast: boolean }[];
}

/** Paid purchases, distinct buyers, chances, gross and known net; `netUnknown` counts the purchases whose net is not reported yet. */
export interface PerformanceBlock {
	purchases: number;
	buyers: number;
	chances: number;
	grossMinor: number;
	netMinor: number;
	netUnknown: number;
}

export function summarizePurchases(orders: readonly PerformanceOrder[]): PerformanceBlock {
	const buyers = new Set<string>();
	const block: PerformanceBlock = { purchases: 0, buyers: 0, chances: 0, grossMinor: 0, netMinor: 0, netUnknown: 0 };
	for (const order of orders) {
		buyers.add(order.contactId);
		block.purchases += 1;
		block.chances += order.chances;
		block.grossMinor += order.grossMinor;
		if (order.netMinor === null) block.netUnknown += 1;
		else block.netMinor += order.netMinor;
	}
	block.buyers = buyers.size;
	return block;
}

/** The link a purchase credits as the last: the marked one, else the most recent touch. */
function lastLinkOf(order: PerformanceOrder): string | null {
	return (order.links.find((link) => link.isLast) ?? order.links.at(-1))?.linkId ?? null;
}

function channelOrder(channel: TrackingChannel | null): number {
	return channel === null ? trackingChannels.length : trackingChannels.indexOf(channel);
}

function byChannel(groups: Map<TrackingChannel | null, PerformanceOrder[]>) {
	return [...groups]
		.sort(([a], [b]) => channelOrder(a) - channelOrder(b))
		.map(([channel, orders]) => ({ channel, ...summarizePurchases(orders) }));
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V) {
	const list = map.get(key);
	if (list) list.push(value);
	else map.set(key, [value]);
}

/**
 * The performance of a campaign's links (S4). "participó" credits a purchase to every link
 * its buyer passed through; "último" only to its last link, so the "último" rows plus the
 * purchases without a link ("Sin link", by the network guessed from the referrer, null when
 * unknown) add up to the campaign total. Each network totals its links' "último" and its
 * purchases without a link. Buyers are distinct within each row, so they do not add up.
 * `links` must hold every link the orders name; every link keeps its row, even without purchases.
 */
export function trackingPerformance<L extends { id: string; channel: TrackingChannel }>(links: readonly L[], orders: readonly PerformanceOrder[]) {
	const participated = new Map<string, PerformanceOrder[]>();
	const last = new Map<string, PerformanceOrder[]>();
	const withoutLink = new Map<TrackingChannel | null, PerformanceOrder[]>();
	const channels = new Map<TrackingChannel | null, PerformanceOrder[]>();
	const channelOf = new Map(links.map((link) => [link.id, link.channel]));
	const counted: PerformanceOrder[] = [];
	for (const order of orders) {
		const lastLink = lastLinkOf(order);
		if (lastLink === null) {
			push(withoutLink, order.sourceChannel, order);
			push(channels, order.sourceChannel, order);
			counted.push(order);
			continue;
		}
		const channel = channelOf.get(lastLink);
		if (channel === undefined) continue;
		for (const linkId of new Set(order.links.map((link) => link.linkId))) push(participated, linkId, order);
		push(last, lastLink, order);
		push(channels, channel, order);
		counted.push(order);
	}
	return {
		links: links.map((link) => ({ ...link, participated: summarizePurchases(participated.get(link.id) ?? []), last: summarizePurchases(last.get(link.id) ?? []) })),
		withoutLink: byChannel(withoutLink),
		channels: byChannel(channels),
		total: summarizePurchases(counted)
	};
}

/** One campaign in the comparison (S4): its paid purchases, and how many came with a link and without one. */
export function campaignPerformance(orders: readonly PerformanceOrder[]): PerformanceBlock & { withLink: number; withoutLink: number } {
	const withLink = orders.filter((order) => order.links.length > 0).length;
	return { ...summarizePurchases(orders), withLink, withoutLink: orders.length - withLink };
}
