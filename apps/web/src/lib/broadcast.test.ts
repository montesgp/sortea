import { describe, expect, it, vi } from 'vitest';
import { broadcastUrl, createBroadcast, FULLSCREEN_HINT, isBroadcastUrl, type FullscreenDocument } from './broadcast';

// Owner feedback 2026-11-14 S1 (ADR 0026 §7): broadcast mode fills the screen like a video player.
// Entering it asks for full screen from the click itself; leaving it, or Esc out of full screen,
// leaves both; a refusal keeps the mode and says how to get full screen by hand.

/** A document whose full screen answers as the browser would: granted, refused, or only with the WebKit prefix. */
function fakeDocument(mode: 'grant' | 'refuse' | 'webkit' | 'none' = 'grant') {
	const listeners = new Map<string, Set<() => void>>();
	const fire = (type: string) => listeners.get(type)?.forEach((listener) => listener());
	const doc = {
		fullscreenElement: null as Element | null,
		webkitFullscreenElement: null as Element | null,
		documentElement: {} as FullscreenDocument['documentElement'],
		addEventListener: (type: string, listener: () => void) => void (listeners.get(type) ?? listeners.set(type, new Set()).get(type)!).add(listener),
		removeEventListener: (type: string, listener: () => void) => void listeners.get(type)?.delete(listener),
		exitFullscreen: vi.fn(async () => {
			doc.fullscreenElement = null;
			fire('fullscreenchange');
		}),
		/** The person presses Esc: the browser leaves full screen by itself. */
		escape() {
			doc.fullscreenElement = null;
			doc.webkitFullscreenElement = null;
			fire('fullscreenchange');
			fire('webkitfullscreenchange');
		},
		listeners
	};
	const element = {} as Element;
	if (mode === 'grant' || mode === 'refuse') {
		doc.documentElement.requestFullscreen = vi.fn(async () => {
			if (mode === 'refuse') throw new TypeError('Permissions check failed');
			doc.fullscreenElement = element;
			fire('fullscreenchange');
		});
	}
	if (mode === 'webkit') {
		doc.documentElement.webkitRequestFullscreen = vi.fn(() => {
			doc.webkitFullscreenElement = element;
			fire('webkitfullscreenchange');
		});
	}
	return doc;
}

/** The page around the controller: the mode lives in the address (`?transmision`). */
function harness(mode: Parameters<typeof fakeDocument>[0] = 'grant', on = false) {
	const doc = fakeDocument(mode);
	const page = { on, fullscreen: false, hint: false, urls: [] as boolean[] };
	const broadcast = createBroadcast({
		doc: doc as unknown as FullscreenDocument,
		isOn: () => page.on,
		setOn: (value) => {
			page.on = value;
			page.urls.push(value);
		},
		onState: (state) => Object.assign(page, state)
	});
	const disconnect = broadcast.connect();
	return { doc, page, broadcast, disconnect };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('the broadcast address', () => {
	it('adds or removes ?transmision and keeps everything else', () => {
		expect(broadcastUrl('https://demo.localhost/admin/sala-de-sorteo/c1?x=1#a', true).href).toBe('https://demo.localhost/admin/sala-de-sorteo/c1?x=1&transmision=#a');
		expect(broadcastUrl('https://demo.localhost/admin/sala-de-sorteo/c1?transmision&x=1', false).href).toBe('https://demo.localhost/admin/sala-de-sorteo/c1?x=1');
		expect(isBroadcastUrl(new URL('https://demo.localhost/admin/sala-de-sorteo/c1?transmision'))).toBe(true);
		expect(isBroadcastUrl(new URL('https://demo.localhost/admin/sala-de-sorteo/c1'))).toBe(false);
		// Only the room has a broadcast mode.
		expect(isBroadcastUrl(new URL('https://demo.localhost/admin/pedidos?transmision'))).toBe(false);
	});
});

describe('entering and leaving broadcast mode', () => {
	it('asks for full screen in the click itself, before anything else, then turns the mode on', async () => {
		const { doc, page, broadcast } = harness();
		broadcast.enter();
		// Synchronous: the request runs while the click still counts as a user gesture.
		expect(doc.documentElement.requestFullscreen).toHaveBeenCalledTimes(1);
		expect(doc.documentElement.requestFullscreen).toHaveBeenCalledWith({ navigationUI: 'hide' });
		expect(page.on).toBe(true);
		await settle();
		expect(page).toMatchObject({ on: true, fullscreen: true, hint: false });
	});

	it('leaving the mode leaves full screen too', async () => {
		const { doc, page, broadcast } = harness();
		broadcast.enter();
		await settle();
		broadcast.toggle();
		expect(doc.exitFullscreen).toHaveBeenCalledTimes(1);
		await settle();
		expect(page).toMatchObject({ on: false, fullscreen: false, hint: false });
		expect(page.urls).toEqual([true, false]);
	});

	it('Esc out of full screen leaves the mode as well, once, with no stuck state', async () => {
		const { doc, page, broadcast } = harness();
		broadcast.enter();
		await settle();
		doc.escape();
		expect(page).toMatchObject({ on: false, fullscreen: false, hint: false });
		expect(doc.exitFullscreen).not.toHaveBeenCalled();
		expect(page.urls).toEqual([true, false]);
		// Entering again works as the first time.
		broadcast.enter();
		await settle();
		expect(page).toMatchObject({ on: true, fullscreen: true });
	});

	it('when the browser refuses full screen the mode still works and says how to get it', async () => {
		const { page, broadcast } = harness('refuse');
		broadcast.enter();
		await settle();
		expect(page).toMatchObject({ on: true, fullscreen: false, hint: true });
		expect(FULLSCREEN_HINT).toBe('Presioná F11 para pantalla completa');
		broadcast.leave();
		expect(page).toMatchObject({ on: false, hint: false });
	});

	it('uses the WebKit prefix where only it exists (Safari), and follows its change event', async () => {
		const { doc, page, broadcast } = harness('webkit');
		broadcast.enter();
		expect(doc.documentElement.webkitRequestFullscreen).toHaveBeenCalledTimes(1);
		await settle();
		expect(page).toMatchObject({ on: true, fullscreen: true, hint: false });
		doc.escape();
		expect(page).toMatchObject({ on: false, fullscreen: false });
	});

	it('without any full screen API the mode works and shows the hint', async () => {
		const { page, broadcast } = harness('none');
		broadcast.enter();
		await settle();
		expect(page).toMatchObject({ on: true, fullscreen: false, hint: true });
	});

	it('opened with ?transmision, full screen is asked by its own button; Esc then leaves the mode', async () => {
		const { doc, page, broadcast } = harness('grant', true);
		broadcast.fullscreen();
		await settle();
		expect(page).toMatchObject({ on: true, fullscreen: true });
		expect(page.urls).toEqual([]);
		doc.escape();
		expect(page).toMatchObject({ on: false, fullscreen: false });
	});

	it('stops listening once disconnected', () => {
		const { doc, disconnect } = harness();
		expect(doc.listeners.get('fullscreenchange')?.size).toBe(1);
		expect(doc.listeners.get('webkitfullscreenchange')?.size).toBe(1);
		disconnect();
		expect(doc.listeners.get('fullscreenchange')?.size).toBe(0);
		expect(doc.listeners.get('webkitfullscreenchange')?.size).toBe(0);
	});
});
