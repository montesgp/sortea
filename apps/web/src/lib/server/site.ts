import { dev } from '$app/env';
import type { RequestEvent } from '@sveltejs/kit';
import { api } from './api';
import { createSiteCache } from './site-cache';
import type { SiteData } from './types';

const cache = createSiteCache<SiteData>({ ttlMs: dev ? 2_000 : 30_000 });

/** Site data per hostname; every page needs it, and none waits once a host is known. */
export async function loadSite(event: Pick<RequestEvent, 'url' | 'getClientAddress' | 'fetch'>): Promise<SiteData | null> {
	return cache.get(event.url.hostname, async () => {
		const result = await api<SiteData>(event, '/public/site');
		return result.ok ? { ok: true, site: result.data } : { ok: false, status: result.status };
	});
}

/**
 * After publishing content this process shows it right away; other web
 * instances pick it up when their cache expires.
 */
export function invalidateSite(hostname: string): void {
	cache.invalidate(hostname);
}
