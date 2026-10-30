import { z } from 'zod';

const WHATSAPP_FORMAT = 'Ingresá el número con código de país, por ejemplo +54 9 2478 40-7084';

/**
 * Normalizes a phone written for people ("+54 9 2478 40-7084") to the digits
 * wa.me expects ("5492478407084"), or null when it is not an international
 * number. Without a leading + or 00 only Argentine numbers (54...) are
 * accepted, because a bare national number cannot be told apart from a foreign one.
 */
export function normalizeWhatsApp(value: string): string | null {
	const compact = value.trim().replace(/[\s().-]/g, '');
	const match = /^(\+|00)?(\d+)$/.exec(compact);
	if (!match) return null;
	const [, prefix, digits = ''] = match;
	if (!prefix && !digits.startsWith('54')) return null;
	// E.164: a country code never starts with 0 and the whole number has at most 15 digits.
	if (digits.startsWith('0') || digits.length < 8 || digits.length > 15) return null;
	// Argentina: 54, the optional mobile 9, then 10 digits of area code (starting 1, 2 or 3) and subscriber number.
	if (digits.startsWith('54') && !/^549?[1-3]\d{9}$/.test(digits)) return null;
	return digits;
}

/** Organization WhatsApp number as stored in settings: digits, or null to remove it. */
export const whatsappNumberSchema = z
	.string()
	.trim()
	.max(40, WHATSAPP_FORMAT)
	.transform((value, context) => {
		if (!value) return null;
		const digits = normalizeWhatsApp(value);
		if (!digits) {
			context.addIssue({ code: 'custom', message: WHATSAPP_FORMAT });
			return z.NEVER;
		}
		return digits;
	});

/**
 * A saved number: the schema stores international digits without the +, so
 * bare digits are read as international here (any country), while typed input
 * keeps the stricter rule above.
 */
export function storedWhatsApp(value: string): string | null {
	return normalizeWhatsApp(/^\d+$/.test(value) ? `+${value}` : value);
}

export function whatsappLink(value: string | null | undefined, text?: string): string | null {
	const digits = value ? storedWhatsApp(value) : null;
	if (!digits) return null;
	return `https://wa.me/${digits}${text ? `?text=${encodeURIComponent(text)}` : ''}`;
}

const MAPS_FORMAT = 'Pegá el enlace de Google Maps completo, empezando por https://';

/** Hosts whose every path is a map: the share short links and the classic maps subdomains. */
const mapsHosts = ['maps.app.goo.gl', 'maps.google.com', 'maps.google.com.ar'];
/** Hosts that serve maps only under /maps: the old goo.gl short links and google.com. */
const mapsPathHosts = ['goo.gl', 'google.com', 'www.google.com', 'google.com.ar', 'www.google.com.ar'];

/**
 * A Google Maps link (S3, feedback 2026-10-30): https, no credentials or port,
 * on an exact host above (never a subdomain or look-alike), or null.
 */
export function mapsLink(value: string): string | null {
	if (value.length > 500) return null;
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return null;
	}
	if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
	const host = url.hostname.toLowerCase();
	if (mapsHosts.includes(host)) return value;
	if (mapsPathHosts.includes(host) && (url.pathname === '/maps' || url.pathname.startsWith('/maps/'))) return value;
	return null;
}

/** The organization's map link as stored in settings: the link, or null to remove it. */
export const mapsUrlSchema = z
	.string()
	.trim()
	.transform((value, context) => {
		if (!value) return null;
		const link = mapsLink(value);
		if (!link) {
			context.addIssue({ code: 'custom', message: MAPS_FORMAT });
			return z.NEVER;
		}
		return link;
	});

export interface PublicContact {
	email?: string;
	phone?: string;
	whatsapp?: string;
	address?: string;
	city?: string;
	/** Google Maps link to the organization's place (S3, feedback 2026-10-30). */
	mapsUrl?: string;
}

/** The contact fields a public page may show; other stored keys never leave the API. */
export function publicContact(contact: Partial<Record<keyof PublicContact, unknown>>): PublicContact {
	const result: PublicContact = {};
	for (const key of ['email', 'phone', 'address', 'city'] as const) {
		const value = contact[key];
		if (typeof value === 'string' && value.trim()) result[key] = value.trim();
	}
	const whatsapp = typeof contact.whatsapp === 'string' ? storedWhatsApp(contact.whatsapp) : null;
	if (whatsapp) result.whatsapp = whatsapp;
	const mapsUrl = typeof contact.mapsUrl === 'string' ? mapsLink(contact.mapsUrl.trim()) : null;
	if (mapsUrl) result.mapsUrl = mapsUrl;
	return result;
}

/** Social networks an organization may link from its public site (S8, feedback 2026-10-18). */
export const socialNetworks = { instagram: 'Instagram', tiktok: 'TikTok', youtube: 'YouTube', facebook: 'Facebook' } as const;
export type SocialNetwork = keyof typeof socialNetworks;
export type SocialLinks = Partial<Record<SocialNetwork, string>>;

const socialHosts: Record<SocialNetwork, string[]> = {
	instagram: ['instagram.com'],
	tiktok: ['tiktok.com'],
	youtube: ['youtube.com', 'youtu.be'],
	facebook: ['facebook.com', 'fb.com']
};

/** An https link whose host is the network's domain or a subdomain of it, never a look-alike. */
function socialLink(network: SocialNetwork, value: string): string | null {
	if (value.length > 200) return null;
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return null;
	}
	if (url.protocol !== 'https:' || url.username || url.password) return null;
	const host = url.hostname.toLowerCase();
	return socialHosts[network].some((domain) => host === domain || host.endsWith(`.${domain}`)) ? value : null;
}

const socialField = (network: SocialNetwork) =>
	z
		.string()
		.optional()
		.transform((value, context) => {
			const trimmed = value?.trim() ?? '';
			if (!trimmed) return undefined;
			const link = socialLink(network, trimmed);
			if (!link) {
				context.addIssue({ code: 'custom', message: `Pegá el enlace completo de tu perfil de ${socialNetworks[network]}, empezando por https://` });
				return z.NEVER;
			}
			return link;
		});

/** The links as stored in settings: an empty field removes that network. */
export const socialLinksSchema = z
	.object({ instagram: socialField('instagram'), tiktok: socialField('tiktok'), youtube: socialField('youtube'), facebook: socialField('facebook') })
	.transform((links): SocialLinks => Object.fromEntries(Object.entries(links).filter(([, value]) => value)));

/** What the public site may show: only valid links of the four networks, whatever is stored. */
export function publicSocial(stored: Partial<Record<string, unknown>> | null | undefined): SocialLinks {
	const result: SocialLinks = {};
	for (const network of Object.keys(socialNetworks) as SocialNetwork[]) {
		const value = stored?.[network];
		const link = typeof value === 'string' ? socialLink(network, value.trim()) : null;
		if (link) result[network] = link;
	}
	return result;
}
