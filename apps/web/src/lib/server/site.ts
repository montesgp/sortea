import { dev } from '$app/env';
import type { RequestEvent } from '@sveltejs/kit';
import { api } from './api';
import type { SiteData } from './types';

const cache = new Map<string, { site: SiteData | null; expires: number }>();
const SITE_TTL_MS = dev ? 2_000 : 30_000;

/** Site data per hostname, cached briefly: every page needs it. */
export async function loadSite(event: Pick<RequestEvent, 'url' | 'getClientAddress' | 'fetch'>): Promise<SiteData | null> {
	const host = event.url.hostname;
	const hit = cache.get(host);
	if (hit && hit.expires > Date.now()) return hit.site;
	const result = await api<SiteData>(event, '/public/site');
	const site = result.ok ? result.data : null;
	// Do not cache outages; do cache "unknown host" briefly.
	if (result.ok || result.status === 404) cache.set(host, { site, expires: Date.now() + SITE_TTL_MS });
	return site;
}

/**
 * After publishing content this process shows it right away; other web
 * instances pick it up when their cache expires.
 */
export function invalidateSite(hostname: string): void {
	cache.delete(hostname);
}
