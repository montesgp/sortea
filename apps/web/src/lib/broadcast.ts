import { BROADCAST_PARAM, DRAW_ROOM_PATH } from './draw-room';

/**
 * The draw room's broadcast mode in full screen (owner feedback 2026-11-14 S1, ADR 0026 §7): like a
 * video player, entering it hides the browser and leaving it, or Esc, brings everything back. The
 * mode lives in the address (`?transmision`, so a reload keeps it and the server renders the bare
 * layout) and is switched on the page itself, never with a navigation that would remount the room
 * and drop full screen.
 */

export const FULLSCREEN_HINT = 'Presioná F11 para pantalla completa';

/** What the room needs of `document`, with Safari's prefixed names. */
export interface FullscreenDocument {
	readonly documentElement: {
		requestFullscreen?: (options?: FullscreenOptions) => Promise<void>;
		webkitRequestFullscreen?: () => void | Promise<void>;
	};
	readonly fullscreenElement?: Element | null;
	readonly webkitFullscreenElement?: Element | null;
	exitFullscreen?: () => Promise<void>;
	webkitExitFullscreen?: () => void | Promise<void>;
	addEventListener(type: string, listener: () => void): void;
	removeEventListener(type: string, listener: () => void): void;
}

const CHANGE_EVENTS = ['fullscreenchange', 'webkitfullscreenchange'] as const;

export const isFullscreen = (doc: FullscreenDocument) => Boolean(doc.fullscreenElement ?? doc.webkitFullscreenElement);

/** Whether this address is a draw room in broadcast mode. */
export function isBroadcastUrl(url: Pick<URL, 'pathname'> & { searchParams: Pick<URLSearchParams, 'has'> }): boolean {
	return url.pathname.startsWith(`${DRAW_ROOM_PATH}/`) && url.searchParams.has(BROADCAST_PARAM);
}

/** The same address with the broadcast flag on or off. */
export function broadcastUrl(href: string | URL, on: boolean): URL {
	const url = new URL(href);
	if (on) url.searchParams.set(BROADCAST_PARAM, '');
	else url.searchParams.delete(BROADCAST_PARAM);
	return url;
}

/**
 * Asks for full screen. Call it from the click itself: browsers grant it only during a user
 * gesture, so the request starts before anything else is awaited. False when refused or missing.
 */
export function requestFullscreen(doc: FullscreenDocument): Promise<boolean> {
	const root = doc.documentElement;
	try {
		const request = root.requestFullscreen ? root.requestFullscreen({ navigationUI: 'hide' }) : root.webkitRequestFullscreen ? root.webkitRequestFullscreen() : null;
		if (request === null) return Promise.resolve(false);
		return Promise.resolve(request).then(
			() => true,
			() => false
		);
	} catch {
		return Promise.resolve(false);
	}
}

export function exitFullscreen(doc: FullscreenDocument): void {
	if (!isFullscreen(doc)) return;
	const exit = doc.exitFullscreen ? doc.exitFullscreen() : doc.webkitExitFullscreen?.();
	void Promise.resolve(exit).catch(() => undefined);
}

export interface BroadcastState {
	/** The page is in full screen. */
	fullscreen: boolean;
	/** Full screen was refused: the mode works, and the screen says how to get it by hand. */
	hint: boolean;
}

/**
 * The broadcast mode's switch. `isOn` and `setOn` are the page's mode (its address); `onState`
 * receives full screen and the hint. Esc out of full screen leaves the mode too, as a player does.
 */
export function createBroadcast(options: { doc: FullscreenDocument; isOn: () => boolean; setOn: (on: boolean) => void; onState: (state: BroadcastState) => void }) {
	const { doc, isOn, setOn, onState } = options;
	const state: BroadcastState = { fullscreen: isFullscreen(doc), hint: false };
	const emit = () => onState({ ...state });

	function fullscreen() {
		const asked = requestFullscreen(doc);
		void asked.then((granted) => {
			if (granted || !isOn()) return;
			state.hint = true;
			emit();
		});
	}

	function enter() {
		if (isOn()) return;
		fullscreen();
		state.hint = false;
		setOn(true);
		emit();
	}

	function leave() {
		if (!isOn()) return;
		state.hint = false;
		setOn(false);
		exitFullscreen(doc);
		emit();
	}

	function changed() {
		const now = isFullscreen(doc);
		const left = state.fullscreen && !now;
		state.fullscreen = now;
		if (now) state.hint = false;
		if (left && isOn()) leave();
		else emit();
	}

	return {
		enter,
		leave,
		toggle: () => (isOn() ? leave() : enter()),
		/** Full screen for a mode already on (the page was opened with `?transmision`). */
		fullscreen,
		/** Follows the browser's full screen; returns the cleanup. */
		connect() {
			for (const type of CHANGE_EVENTS) doc.addEventListener(type, changed);
			return () => {
				for (const type of CHANGE_EVENTS) doc.removeEventListener(type, changed);
			};
		}
	};
}
