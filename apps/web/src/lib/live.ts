/**
 * Client side of the live dashboard (FR-OPS-02, AC-04, ADR 0007). Events only
 * say that something changed, so every reaction is the same: re-read the
 * snapshot, debounced so a burst of payments causes one reload. When the
 * stream is refused or unavailable, the page falls back to polling.
 */
export type LiveStatus = 'connecting' | 'live' | 'reconnecting' | 'polling';

interface EventSourceLike {
	readonly readyState: number;
	onopen: ((event: Event) => void) | null;
	onerror: ((event: Event) => void) | null;
	addEventListener(type: string, listener: () => void): void;
	close(): void;
}

export interface LiveOptions {
	/** Stream URL, including `?after=` with the sequence of the rendered snapshot. */
	readonly url: string;
	readonly refresh: () => Promise<unknown>;
	readonly onStatus: (status: LiveStatus) => void;
	readonly createSource?: (url: string) => EventSourceLike;
	readonly debounceMs?: number;
	readonly pollMs?: number;
	readonly isVisible?: () => boolean;
}

const CLOSED = 2;

export function connectLive(options: LiveOptions): () => void {
	const debounceMs = options.debounceMs ?? 400;
	const pollMs = options.pollMs ?? 30_000;
	const isVisible = options.isVisible ?? (() => true);
	let pending: ReturnType<typeof setTimeout> | null = null;
	let poll: ReturnType<typeof setInterval> | null = null;
	let stopped = false;

	const scheduleRefresh = () => {
		if (stopped) return;
		if (pending) clearTimeout(pending);
		pending = setTimeout(() => {
			pending = null;
			if (!stopped && isVisible()) void options.refresh();
		}, debounceMs);
	};

	const source = (options.createSource ?? ((url) => new EventSource(url)))(options.url);
	options.onStatus('connecting');
	source.onopen = () => options.onStatus('live');
	source.addEventListener('ops', scheduleRefresh);
	source.addEventListener('resync', scheduleRefresh);
	source.onerror = () => {
		if (source.readyState !== CLOSED) {
			// The browser reconnects by itself and resumes after the last event id.
			options.onStatus('reconnecting');
			return;
		}
		// Refused (signed out, no permission, too many tabs) or gone: keep the numbers fresh by polling.
		options.onStatus('polling');
		if (!poll) poll = setInterval(scheduleRefresh, pollMs);
		scheduleRefresh();
	};

	return () => {
		stopped = true;
		source.close();
		if (pending) clearTimeout(pending);
		if (poll) clearInterval(poll);
	};
}
