import { describe, expect, it } from 'vitest';
import {
	attributionSchema,
	campaignTakesTouches,
	checkoutRequestSchema,
	MAX_TRACKING_TOUCHES,
	selectAttribution,
	trackingCodeSchema,
	trackingLinkInputSchema,
	type AttributableLink
} from '../src';
import { generateTrackingCode } from '../src/server';

/** odd/tasks/tracking-links.md S1-S3: links per video, touches until the campaign closes, purchases credited to every link. */
const now = new Date('2026-11-07T15:00:00Z');
const minutes = (value: number) => new Date(now.getTime() + value * 60_000);

const link = (code: string, overrides: Partial<AttributableLink> = {}): AttributableLink => ({
	id: `id-${code}`,
	code,
	createdAt: minutes(-60 * 24),
	archivedAt: null,
	campaign: { status: 'open', closesAt: minutes(60 * 24 * 7) },
	...overrides
});

describe('tracking codes (S1)', () => {
	it('generates short URL-safe codes that the schema accepts', () => {
		const codes = new Set(Array.from({ length: 200 }, () => generateTrackingCode()));
		expect(codes.size).toBe(200);
		for (const code of codes) {
			expect(code).toMatch(/^[a-z0-9]{8}$/);
			expect(trackingCodeSchema.safeParse(code).success).toBe(true);
		}
	});

	it('refuses codes that are not ours', () => {
		for (const code of ['', 'ABCDEFGH', 'abc', 'abcdefgh1', 'abc-defg', '<script>']) expect(trackingCodeSchema.safeParse(code).success).toBe(false);
	});

	it('asks for a name and a known network; the note is optional', () => {
		expect(trackingLinkInputSchema.parse({ name: '  Video moto roja  ', channel: 'instagram' })).toEqual({ name: 'Video moto roja', channel: 'instagram' });
		expect(trackingLinkInputSchema.parse({ name: 'Reel', channel: 'other', note: ' historia ' })).toEqual({ name: 'Reel', channel: 'other', note: 'historia' });
		expect(trackingLinkInputSchema.parse({ name: 'Reel', channel: 'tiktok', note: '' })).toEqual({ name: 'Reel', channel: 'tiktok' });
		expect(trackingLinkInputSchema.safeParse({ name: 'R', channel: 'instagram' }).success).toBe(false);
		expect(trackingLinkInputSchema.safeParse({ name: 'Reel', channel: 'snapchat' }).success).toBe(false);
	});
});

describe('which campaigns take touches (S2)', () => {
	it('takes them until the campaign closes', () => {
		for (const status of ['draft', 'review', 'published', 'open'] as const) {
			expect(campaignTakesTouches({ status, closesAt: minutes(1) }, now)).toBe(true);
			expect(campaignTakesTouches({ status, closesAt: now }, now)).toBe(false);
		}
		for (const status of ['closed', 'awarding', 'fulfilled', 'archived'] as const) expect(campaignTakesTouches({ status, closesAt: minutes(60) }, now)).toBe(false);
	});
});

describe('attribution sent with the checkout', () => {
	it('accepts up to ten touches and a channel guess', () => {
		const touches = Array.from({ length: MAX_TRACKING_TOUCHES }, (_, index) => ({ code: `code000${index}`.slice(0, 8), at: now.toISOString() }));
		expect(attributionSchema.parse({ touches, channel: 'instagram' }).touches).toHaveLength(10);
		expect(attributionSchema.safeParse({ touches: [...touches, touches[0]] }).success).toBe(false);
	});

	it('never fails the checkout: malformed attribution is dropped', () => {
		const base = {
			lines: [{ variantId: '7f0b5c8e-8a42-4a8c-9a37-5f3c1b1d2e4f', quantity: 1 }],
			buyer: { documentType: 'DNI', documentNumber: '30123456', firstName: 'Ana', lastName: 'Paz', email: 'ana@example.com', province: 'Córdoba', city: 'Río Cuarto' },
			delivery: { method: 'digital' },
			consents: { terms: true, privacy: true, marketingEmail: false }
		};
		for (const attribution of [{ touches: [{ code: 'NOT A CODE', at: 'yesterday' }] }, { touches: 'x' }, { channel: 'myspace' }, 42]) {
			const parsed = checkoutRequestSchema.safeParse({ ...base, attribution });
			expect(parsed.success).toBe(true);
			expect(parsed.data?.attribution).toBeUndefined();
		}
		expect(checkoutRequestSchema.parse(base).attribution).toBeUndefined();
		expect(checkoutRequestSchema.parse({ ...base, attribution: { touches: [{ code: 'abcd2345', at: now.toISOString() }] } }).attribution).toEqual({
			touches: [{ code: 'abcd2345', at: now }]
		});
	});
});

describe('selectAttribution (S3)', () => {
	const links = [link('aaaa2222'), link('bbbb3333'), link('cccc4444')];

	it('credits every valid link and marks the most recent touch as the last one', () => {
		const result = selectAttribution(
			[
				{ code: 'bbbb3333', at: minutes(-30) },
				{ code: 'aaaa2222', at: minutes(-120) },
				{ code: 'cccc4444', at: minutes(-60) }
			],
			links,
			now
		);
		expect(result).toEqual([
			{ trackingLinkId: 'id-aaaa2222', touchedAt: minutes(-120), isLast: false },
			{ trackingLinkId: 'id-cccc4444', touchedAt: minutes(-60), isLast: false },
			{ trackingLinkId: 'id-bbbb3333', touchedAt: minutes(-30), isLast: true }
		]);
	});

	it('keeps one row per link, at its latest touch', () => {
		const result = selectAttribution(
			[
				{ code: 'aaaa2222', at: minutes(-10) },
				{ code: 'bbbb3333', at: minutes(-20) },
				{ code: 'aaaa2222', at: minutes(-90) }
			],
			links,
			now
		);
		expect(result).toEqual([
			{ trackingLinkId: 'id-bbbb3333', touchedAt: minutes(-20), isLast: false },
			{ trackingLinkId: 'id-aaaa2222', touchedAt: minutes(-10), isLast: true }
		]);
	});

	it('drops unknown, archived and closed-campaign links, and touches outside the link life', () => {
		const result = selectAttribution(
			[
				{ code: 'zzzz9999', at: minutes(-5) },
				{ code: 'dddd5555', at: minutes(-5) },
				{ code: 'eeee6666', at: minutes(-5) },
				{ code: 'ffff7777', at: minutes(-5) },
				{ code: 'aaaa2222', at: minutes(-60 * 24 * 2) },
				{ code: 'bbbb3333', at: minutes(30) },
				{ code: 'cccc4444', at: minutes(-40) }
			],
			[
				...links,
				link('dddd5555', { archivedAt: minutes(-1) }),
				link('eeee6666', { campaign: { status: 'closed', closesAt: minutes(60) } }),
				link('ffff7777', { campaign: { status: 'open', closesAt: minutes(-1) } })
			],
			now
		);
		expect(result).toEqual([{ trackingLinkId: 'id-cccc4444', touchedAt: minutes(-40), isLast: true }]);
	});

	it('tolerates a few minutes of clock difference, never recording a touch after the purchase', () => {
		const result = selectAttribution([{ code: 'aaaa2222', at: minutes(2) }], links, now);
		expect(result).toEqual([{ trackingLinkId: 'id-aaaa2222', touchedAt: now, isLast: true }]);
	});

	it('records nothing without touches', () => {
		expect(selectAttribution([], links, now)).toEqual([]);
	});
});
