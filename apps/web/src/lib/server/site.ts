import { dev } from '$app/env';
import type { RequestEvent } from '@sveltejs/kit';
import { api } from './api';
import { createSiteCache } from './site-cache';
import type { SiteData } from './types';

/** A suspended organization's host is remembered like a site, so its paused page needs no API call (S13). */
const SUSPENDED = 'suspended';
const cache = createSiteCache<SiteData | typeof SUSPENDED>({ ttlMs: dev ? 2_000 : 30_000 });

export interface SiteState {
	site: SiteData | null;
	/** The host belongs to a suspended organization: its public pages are paused, the panel is not. */
	suspended: boolean;
}

/** Site data per hostname; every page needs it, and none waits once a host is known. */
export async function loadSite(event: Pick<RequestEvent, 'url' | 'getClientAddress' | 'fetch'>): Promise<SiteState> {
	const entry = await cache.get(event.url.hostname, async () => {
		const result = await api<SiteData>(event, '/public/site');
		if (result.ok) return { ok: true, site: result.data };
		// Only the API's own answer means suspended: an unreachable API is a 503 too.
		if (result.code === 'site_suspended') return { ok: true, site: SUSPENDED };
		return { ok: false, status: result.status };
	});
	return entry === SUSPENDED ? { site: null, suspended: true } : { site: entry, suspended: false };
}

/**
 * After publishing content this process shows it right away; other web
 * instances pick it up when their cache expires.
 */
export function invalidateSite(hostname: string): void {
	cache.invalidate(hostname);
}
