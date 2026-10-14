import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectLive, type LiveStatus } from './live';

class FakeSource {
	readyState = 0;
	onopen: ((event: Event) => void) | null = null;
	onerror: ((event: Event) => void) | null = null;
	closed = false;
	readonly listeners = new Map<string, () => void>();
	constructor(readonly url: string) {}
	addEventListener(type: string, listener: () => void) {
		this.listeners.set(type, listener);
	}
	close() {
		this.closed = true;
	}
	emit(type: string) {
		this.listeners.get(type)?.();
	}
}

let source: FakeSource;
let statuses: LiveStatus[];
let refreshes: number;
let stop: () => void;

beforeEach(() => {
	vi.useFakeTimers();
	statuses = [];
	refreshes = 0;
	stop = connectLive({
		url: '/admin/eventos?after=41',
		refresh: async () => {
			refreshes++;
		},
		onStatus: (status) => statuses.push(status),
		createSource: (url) => (source = new FakeSource(url)),
		debounceMs: 400,
		pollMs: 30_000
	});
});
afterEach(() => {
	stop();
	vi.useRealTimers();
});

describe('live dashboard client', () => {
	it('resumes from the rendered snapshot and reports when it is live', () => {
		expect(source.url).toBe('/admin/eventos?after=41');
		source.onopen?.(new Event('open'));
		expect(statuses).toEqual(['connecting', 'live']);
	});

	it('re-reads the snapshot once for a burst of changes', () => {
		source.emit('ops');
		source.emit('ops');
		source.emit('ops');
		vi.advanceTimersByTime(399);
		expect(refreshes).toBe(0);
		vi.advanceTimersByTime(1);
		expect(refreshes).toBe(1);
	});

	it('resyncs after the server says events may have been missed (AC-04)', () => {
		source.emit('resync');
		vi.advanceTimersByTime(400);
		expect(refreshes).toBe(1);
	});

	it('shows reconnection while the browser retries, and live again afterwards', () => {
		source.readyState = 0;
		source.onerror?.(new Event('error'));
		source.onopen?.(new Event('open'));
		expect(statuses.slice(-2)).toEqual(['reconnecting', 'live']);
		vi.advanceTimersByTime(60_000);
		expect(refreshes).toBe(0);
	});

	it('falls back to polling when the stream is refused', () => {
		source.readyState = 2;
		source.onerror?.(new Event('error'));
		expect(statuses.at(-1)).toBe('polling');
		vi.advanceTimersByTime(400);
		expect(refreshes).toBe(1);
		vi.advanceTimersByTime(30_400);
		expect(refreshes).toBe(2);
	});

	it('stops everything when the page goes away', () => {
		source.emit('ops');
		stop();
		vi.advanceTimersByTime(60_000);
		expect(source.closed).toBe(true);
		expect(refreshes).toBe(0);
	});
});
