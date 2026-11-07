import { describe, expect, it } from 'vitest';
import {
	addTouch,
	attributionOf,
	CHANNEL_GUESS_DAYS,
	classifyReferrer,
	emptyTracking,
	guessChannel,
	parseTracking,
	serializeTracking,
	trackingExpires,
	withoutSrc,
	type Tracking
} from './tracking';

// odd/tasks/tracking-links.md S2: the links a visitor came through, in a first-party
// cookie without personal data, each remembered until its campaign closes.

const now = Date.parse('2026-11-07T15:00:00Z');
const seconds = (ms: number) => Math.floor(ms / 1000);
const at = (minutes: number) => seconds(now + minutes * 60_000);
const close = at(60 * 24 * 10);

function touches(state: Tracking) {
	return state.touches.map((touch) => touch.code);
}

describe('tracking cookie', () => {
	it('round-trips through its serialized form', () => {
		const state = addTouch(addTouch(emptyTracking(), { code: 'aaaa2222', at: at(-5), until: close }), { code: 'bbbb3333', at: at(-1), until: at(60) });
		const raw = serializeTracking(state);
		expect(raw).toBe(`{"t":[["aaaa2222",${at(-5)},${close}],["bbbb3333",${at(-1)},${at(60)}]]}`);
		expect(parseTracking(raw, now)).toEqual(state);
	});

	it('ignores a missing, malformed or tampered cookie without failing', () => {
		for (const raw of [undefined, '', 'nope', '{"t":"x"}', '[1,2]', '{"t":[["BAD CODE",1,2]]}', '{"t":[["aaaa2222","x",2]]}', '{"g":["myspace",1,2]}']) {
			const state = parseTracking(raw, now);
			expect(state.touches.filter((touch) => touch.code === 'BAD CODE')).toEqual([]);
			expect(state.guess).toBeNull();
		}
		// The valid entries of a partly tampered cookie are kept.
		expect(touches(parseTracking(`{"t":[["BAD CODE",1,${close}],["aaaa2222",${at(-1)},${close}]]}`, now))).toEqual(['aaaa2222']);
	});

	it('forgets each touch when its campaign closes', () => {
		const raw = `{"t":[["aaaa2222",${at(-60)},${at(-1)}],["bbbb3333",${at(-30)},${close}]]}`;
		expect(touches(parseTracking(raw, now))).toEqual(['bbbb3333']);
	});

	it('keeps one entry per code, with its latest time, oldest first', () => {
		let state = emptyTracking();
		state = addTouch(state, { code: 'aaaa2222', at: at(-30), until: close });
		state = addTouch(state, { code: 'bbbb3333', at: at(-20), until: close });
		state = addTouch(state, { code: 'aaaa2222', at: at(-10), until: close });
		expect(state.touches).toEqual([
			{ code: 'bbbb3333', at: at(-20), until: close },
			{ code: 'aaaa2222', at: at(-10), until: close }
		]);
	});

	it('remembers at most ten links, dropping the oldest', () => {
		let state = emptyTracking();
		for (let index = 0; index < 12; index++) state = addTouch(state, { code: `code${String(index).padStart(4, '0')}`, at: at(index - 20), until: close });
		expect(state.touches).toHaveLength(10);
		expect(state.touches[0]!.code).toBe('code0002');
		expect(state.touches.at(-1)!.code).toBe('code0011');
		// Read back, a cookie with more than ten entries keeps the latest ten too.
		const many = JSON.stringify({ t: Array.from({ length: 12 }, (_, index) => [`code${String(index).padStart(4, '0')}`, at(index - 20), close]) });
		expect(touches(parseTracking(many, now))).toEqual(state.touches.map((touch) => touch.code));
	});

	it('expires at the latest campaign close among its entries', () => {
		expect(trackingExpires(emptyTracking())).toBeNull();
		const state = addTouch(addTouch(emptyTracking(), { code: 'aaaa2222', at: at(-5), until: close }), { code: 'bbbb3333', at: at(-1), until: at(60) });
		expect(trackingExpires(state)).toEqual(new Date(close * 1000));
	});

	it('remembers a network guess, which expires on its own', () => {
		const state = guessChannel(emptyTracking(), 'instagram', now);
		expect(state.guess).toEqual({ channel: 'instagram', at: seconds(now), until: seconds(now) + CHANNEL_GUESS_DAYS * 86_400 });
		expect(trackingExpires(state)).toEqual(new Date((seconds(now) + CHANNEL_GUESS_DAYS * 86_400) * 1000));
		expect(parseTracking(serializeTracking(state), now)).toEqual(state);
		expect(parseTracking(serializeTracking(state), now + (CHANNEL_GUESS_DAYS + 1) * 86_400_000).guess).toBeNull();
	});

	it('sends the touches and the guess to the checkout, or nothing', () => {
		expect(attributionOf(emptyTracking())).toBeUndefined();
		const state = guessChannel(addTouch(emptyTracking(), { code: 'aaaa2222', at: at(-5), until: close }), 'tiktok', now);
		expect(attributionOf(state)).toEqual({ touches: [{ code: 'aaaa2222', at: new Date(at(-5) * 1000).toISOString() }], channel: 'tiktok' });
	});
});

describe('classifyReferrer', () => {
	it('recognizes the social networks the links are shared on', () => {
		const cases: [string, string][] = [
			['https://instagram.com/', 'instagram'],
			['https://l.instagram.com/?u=x', 'instagram'],
			['https://www.instagram.com/reel/1', 'instagram'],
			['https://facebook.com/', 'facebook'],
			['https://l.facebook.com/', 'facebook'],
			['https://m.facebook.com/', 'facebook'],
			['https://www.tiktok.com/@x', 'tiktok'],
			['https://www.youtube.com/watch?v=1', 'youtube'],
			['https://m.youtube.com/', 'youtube'],
			['https://t.co/abc', 'other'],
			['https://x.com/someone', 'other'],
			['https://wa.me/549', 'whatsapp'],
			['https://web.whatsapp.com/', 'whatsapp']
		];
		for (const [referer, channel] of cases) expect(classifyReferrer(referer), referer).toBe(channel);
	});

	it('ignores any other site, a missing header and look-alike hosts', () => {
		for (const referer of [null, undefined, '', 'not a url', 'https://google.com/', 'https://localhost:5173/tienda', 'https://notinstagram.com/', 'https://instagram.com.evil.test/']) {
			expect(classifyReferrer(referer), String(referer)).toBeNull();
		}
	});
});

describe('withoutSrc', () => {
	it('never returns an address another site could take over', () => {
		for (const raw of ['http://shop.test//evil.example/?src=abc', 'http://shop.test/\evil.example/?src=abc', 'http://shop.test///evil.example/x?src=abc&a=1']) {
			const target = withoutSrc(new URL(raw));
			expect(target.startsWith('//'), raw).toBe(false);
			expect(new URL(target, 'http://shop.test').origin, raw).toBe('http://shop.test');
		}
	});

	it('drops only the code from the address', () => {
		expect(withoutSrc(new URL('http://localhost:5173/?src=aaaa2222'))).toBe('/');
		expect(withoutSrc(new URL('http://localhost:5173/sorteos/moto?src=aaaa2222&utm=x#premios'))).toBe('/sorteos/moto?utm=x#premios');
	});
});
