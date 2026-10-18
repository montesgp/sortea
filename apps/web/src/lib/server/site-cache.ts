/**
 * Site data (organization, theme, content) per hostname, served from memory
 * (S3, feedback 2026-10-17b). Only the first request of a host waits for the
 * API; an expired copy is served at once while one background request
 * refreshes it, and an outage keeps the last good copy. An unknown host is
 * remembered for one TTL too, then asked again before answering. Each call
 * brings its own loader, so a refresh always asks for the host it is stored
 * under. Forgetting a host also discards a refresh already running for it,
 * so a publish is never overwritten by an answer from before it.
 */
export type SiteLoad<T> = () => Promise<{ ok: true; site: T } | { ok: false; status: number }>;

export function createSiteCache<T>({ ttlMs, now = Date.now }: { ttlMs: number; now?: () => number }) {
	const entries = new Map<string, { site: T | null; expires: number }>();
	const refreshing = new Map<string, { generation: number; request: Promise<T | null> }>();
	const generations = new Map<string, number>();
	const generationOf = (host: string) => generations.get(host) ?? 0;

	function refresh(host: string, load: SiteLoad<T>, fallback: T | null): Promise<T | null> {
		const generation = generationOf(host);
		const running = refreshing.get(host);
		if (running && running.generation === generation) return running.request;
		const request = load()
			.then((result) => {
				// Forgotten meanwhile: this answer predates the change, do not keep it.
				if (generationOf(host) !== generation) return fallback;
				if (result.ok || result.status === 404) {
					const site = result.ok ? result.site : null;
					entries.set(host, { site, expires: now() + ttlMs });
					return site;
				}
				return fallback;
			})
			.catch(() => fallback)
			.finally(() => {
				if (refreshing.get(host)?.request === request) refreshing.delete(host);
			});
		refreshing.set(host, { generation, request });
		return request;
	}

	return {
		async get(host: string, load: SiteLoad<T>): Promise<T | null> {
			const entry = entries.get(host);
			if (!entry) return refresh(host, load, null);
			if (entry.expires > now()) return entry.site;
			// A known site is served stale while it refreshes; an unknown host is asked again,
			// so a domain just added does not show "no site" to its next visitor.
			if (entry.site === null) return refresh(host, load, null);
			void refresh(host, load, entry.site);
			return entry.site;
		},
		invalidate(host: string) {
			entries.delete(host);
			generations.set(host, generationOf(host) + 1);
		},
		/** Resolves when no refresh is running; for tests. */
		async settled() {
			await Promise.all([...refreshing.values()].map((running) => running.request));
		}
	};
}
