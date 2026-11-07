import { MAX_TRACKING_TOUCHES, trackingChannelSchema, trackingCodeSchema, type TrackingChannel } from '@sortea/domain';
import { z } from 'zod';

/**
 * The links a visitor came through (odd/tasks/tracking-links.md S2), in a first-party,
 * httpOnly cookie with no personal data:
 *
 *   sortea_src={"t":[["k7m2p9qa",1762527600,1764370800]],"g":["instagram",1762520000,1765112000]}
 *
 * `t` holds up to ten touches as [code, touched at, remembered until] in Unix seconds, oldest
 * first, one per code at its latest visit; each is remembered until its campaign closes. `g`
 * is the network guessed from the referrer of a visit without a link, kept for
 * `CHANNEL_GUESS_DAYS`. The cookie expires with its last entry. The API checks every code
 * again at checkout: this cookie only says where the visitor came from.
 */
export const TRACKING_COOKIE = 'sortea_src';
export const CHANNEL_GUESS_DAYS = 30;

export interface Touch {
	code: string;
	/** Unix seconds. */
	at: number;
	/** Unix seconds: the close of the link's campaign. */
	until: number;
}

export interface Tracking {
	touches: Touch[];
	guess: { channel: TrackingChannel; at: number; until: number } | null;
}

const seconds = z.number().int().nonnegative();
const entrySchema = z.tuple([trackingCodeSchema, seconds, seconds]);
const guessSchema = z.tuple([trackingChannelSchema, seconds, seconds]);
const rawSchema = z.object({ t: z.array(z.unknown()).max(50).optional(), g: z.unknown().optional() });

export function emptyTracking(): Tracking {
	return { touches: [], guess: null };
}

/** Reads the cookie, keeping only well-formed entries that have not expired. Never throws. */
export function parseTracking(raw: string | undefined, nowMs: number): Tracking {
	if (!raw) return emptyTracking();
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return emptyTracking();
	}
	const parsed = rawSchema.safeParse(value);
	if (!parsed.success) return emptyTracking();
	const now = Math.floor(nowMs / 1000);
	let state = emptyTracking();
	for (const entry of parsed.data.t ?? []) {
		const touch = entrySchema.safeParse(entry);
		if (touch.success && touch.data[2] > now) state = addTouch(state, { code: touch.data[0], at: touch.data[1], until: touch.data[2] });
	}
	const guess = guessSchema.safeParse(parsed.data.g);
	if (guess.success && guess.data[2] > now) state.guess = { channel: guess.data[0], at: guess.data[1], until: guess.data[2] };
	return state;
}

export function serializeTracking(state: Tracking): string {
	const value: { t?: [string, number, number][]; g?: [string, number, number] } = {};
	if (state.touches.length) value.t = state.touches.map((touch) => [touch.code, touch.at, touch.until]);
	if (state.guess) value.g = [state.guess.channel, state.guess.at, state.guess.until];
	return JSON.stringify(value);
}

/** Adds a visit through a link: one entry per code at its latest time, the latest ten, oldest first. */
export function addTouch(state: Tracking, touch: Touch): Tracking {
	const previous = state.touches.find((candidate) => candidate.code === touch.code);
	const merged = previous ? { code: touch.code, at: Math.max(previous.at, touch.at), until: Math.max(previous.until, touch.until) } : touch;
	const touches = [...state.touches.filter((candidate) => candidate.code !== touch.code), merged].sort((a, b) => a.at - b.at).slice(-MAX_TRACKING_TOUCHES);
	return { ...state, touches };
}

/** Remembers the network a visit without a link came from. */
export function guessChannel(state: Tracking, channel: TrackingChannel, nowMs: number): Tracking {
	const at = Math.floor(nowMs / 1000);
	return { ...state, guess: { channel, at, until: at + CHANNEL_GUESS_DAYS * 86_400 } };
}

/** When the cookie expires: with its last entry, or null when it holds nothing. */
export function trackingExpires(state: Tracking): Date | null {
	const until = Math.max(0, ...state.touches.map((touch) => touch.until), state.guess?.until ?? 0);
	return until ? new Date(until * 1000) : null;
}

/** What a checkout forwards to the API, or nothing when the visitor came through no link and no known network. */
export function attributionOf(state: Tracking): { touches: { code: string; at: string }[]; channel?: TrackingChannel } | undefined {
	if (!state.touches.length && !state.guess) return undefined;
	return {
		touches: state.touches.map((touch) => ({ code: touch.code, at: new Date(touch.at * 1000).toISOString() })),
		...(state.guess ? { channel: state.guess.channel } : {})
	};
}

/** How the back office names each network. */
export const trackingChannelLabel: Record<TrackingChannel, string> = {
	instagram: 'Instagram',
	facebook: 'Facebook',
	tiktok: 'TikTok',
	youtube: 'YouTube',
	whatsapp: 'WhatsApp',
	other: 'Otra'
};

/** Social networks recognized by the referrer host (the host itself or any subdomain). X has no channel of its own. */
const referrerHosts: [string, TrackingChannel][] = [
	['instagram.com', 'instagram'],
	['facebook.com', 'facebook'],
	['fb.com', 'facebook'],
	['tiktok.com', 'tiktok'],
	['youtube.com', 'youtube'],
	['youtu.be', 'youtube'],
	['wa.me', 'whatsapp'],
	['whatsapp.com', 'whatsapp'],
	['t.co', 'other'],
	['x.com', 'other'],
	['twitter.com', 'other']
];

/** The network a visit came from, by its Referer header; null for any other site or none. */
export function classifyReferrer(referer: string | null | undefined): TrackingChannel | null {
	if (!referer) return null;
	let host: string;
	try {
		host = new URL(referer).hostname.toLowerCase();
	} catch {
		return null;
	}
	return referrerHosts.find(([domain]) => host === domain || host.endsWith(`.${domain}`))?.[1] ?? null;
}

/** The same address without the link code, so it is not shared further and the page stays cacheable. */
export function withoutSrc(url: URL): string {
	const params = new URLSearchParams(url.search);
	params.delete('src');
	const search = params.toString();
	// A path like //host/ or /\host/ would read as another origin: collapse it to one leading slash.
	const path = url.pathname.replace(/^[/\\]+/, '/');
	return `${path}${search ? `?${search}` : ''}${url.hash}`;
}
