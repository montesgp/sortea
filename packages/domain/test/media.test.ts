import { describe, expect, it } from 'vitest';
import {
	campaignVideoSchema,
	checkMediaUpload,
	collectMediaRefs,
	imageRefSchema,
	MEDIA_MAX_BYTES,
	mediaKindOf,
	mediaStoragePath,
	prizeChangeAllowed,
	prizeInputSchema,
	resolveVideo,
	sniffVideo,
	VIDEO_MAX_BYTES,
	videoRefSchema
} from '../src';

const org = '6f1c2a5e-0b8d-4e7a-9c3f-2d1e0a9b8c7d';
const sha = 'b'.repeat(64);
const ascii = (text: string) => [...text].map((char) => char.charCodeAt(0));

/** An ISO BMFF file starts with a `ftyp` box: size, "ftyp", major brand, minor version, compatible brands. */
const mp4 = (brand = 'isom') => new Uint8Array([0, 0, 0, 0x18, ...ascii('ftyp'), ...ascii(brand), 0, 0, 2, 0, ...ascii('isom'), ...ascii('mp41')]);
/** A WebM file starts with an EBML header whose DocType is "webm". */
const webm = (docType = 'webm') =>
	new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0xf7, 0x81, 0x01, 0x42, 0x82, 0x80 | docType.length, ...ascii(docType), 0x42, 0x87, 0x81, 0x04]);
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);

describe('video uploads (S9)', () => {
	it('recognizes MP4 and WebM by their bytes', () => {
		expect(sniffVideo(mp4())).toEqual({ contentType: 'video/mp4', extension: 'mp4' });
		expect(sniffVideo(mp4('mp42'))).toEqual({ contentType: 'video/mp4', extension: 'mp4' });
		expect(sniffVideo(webm())).toEqual({ contentType: 'video/webm', extension: 'webm' });
	});

	it('refuses look-alikes: HEIC/AVIF images, QuickTime, Matroska and anything else', () => {
		expect(sniffVideo(mp4('heic'))).toBeNull();
		expect(sniffVideo(mp4('avif'))).toBeNull();
		expect(sniffVideo(mp4('qt  '))).toBeNull();
		expect(sniffVideo(webm('matroska'))).toBeNull();
		expect(sniffVideo(jpeg)).toBeNull();
		expect(sniffVideo(new TextEncoder().encode('ftyp isom, but not a box'))).toBeNull();
		expect(sniffVideo(new Uint8Array())).toBeNull();
	});

	it('takes videos up to 50 MB and keeps images at 2 MB', () => {
		expect(VIDEO_MAX_BYTES).toBe(50 * 1024 * 1024);
		expect(MEDIA_MAX_BYTES).toBe(2 * 1024 * 1024);
		expect(checkMediaUpload(mp4(), mp4().length)).toEqual({ ok: true, kind: 'video', contentType: 'video/mp4', extension: 'mp4' });
		expect(checkMediaUpload(jpeg, jpeg.length)).toEqual({ ok: true, kind: 'image', contentType: 'image/jpeg', extension: 'jpg' });
		expect(checkMediaUpload(webm(), VIDEO_MAX_BYTES)).toMatchObject({ ok: true, kind: 'video' });
		expect(checkMediaUpload(webm(), VIDEO_MAX_BYTES + 1)).toEqual({ ok: false, reason: 'too_large', kind: 'video', maxBytes: VIDEO_MAX_BYTES });
		expect(checkMediaUpload(jpeg, MEDIA_MAX_BYTES)).toMatchObject({ ok: true, kind: 'image' });
		expect(checkMediaUpload(jpeg, MEDIA_MAX_BYTES + 1)).toEqual({ ok: false, reason: 'too_large', kind: 'image', maxBytes: MEDIA_MAX_BYTES });
		expect(checkMediaUpload(mp4('heic'), 100)).toEqual({ ok: false, reason: 'unsupported' });
	});

	it('stores videos under the organization by content and tells their kind', () => {
		expect(mediaStoragePath(org, sha, 'mp4')).toBe(`${org}/${sha}.mp4`);
		expect(mediaStoragePath(org, sha, 'webm')).toBe(`${org}/${sha}.webm`);
		expect(mediaKindOf(`${org}/${sha}.webm`)).toBe('video');
		expect(mediaKindOf(`${org}/${sha}.png`)).toBe('image');
		expect(collectMediaRefs({ video: `media:${org}/${sha}.mp4` })).toEqual([`${org}/${sha}.mp4`]);
	});
});

describe('campaign and prize videos (S9)', () => {
	const uploaded = `media:${org}/${sha}.mp4`;

	it('accepts an uploaded video or a YouTube link, nothing else', () => {
		expect(videoRefSchema.safeParse(uploaded).success).toBe(true);
		expect(videoRefSchema.safeParse(`media:${org}/${sha}.webm`).success).toBe(true);
		expect(videoRefSchema.safeParse('https://youtu.be/dQw4w9WgXcQ').success).toBe(true);
		expect(videoRefSchema.safeParse(`media:${org}/${sha}.jpg`).success).toBe(false);
		expect(videoRefSchema.safeParse('https://vimeo.com/123456').success).toBe(false);
		expect(videoRefSchema.safeParse('http://youtube.com/watch?v=dQw4w9WgXcQ').success).toBe(false);
		expect(videoRefSchema.safeParse('https://cdn.example.com/clip.mp4').success).toBe(false);
		expect(videoRefSchema.safeParse(`media:${org}/../${sha}.mp4`).success).toBe(false);
	});

	it('never takes a video where an image goes', () => {
		expect(imageRefSchema.safeParse(uploaded).success).toBe(false);
		expect(imageRefSchema.safeParse(`media:${org}/${sha}.jpg`).success).toBe(true);
	});

	it('is optional on campaigns and prizes', () => {
		expect(campaignVideoSchema.safeParse(null).success).toBe(true);
		expect(campaignVideoSchema.safeParse('https://www.youtube.com/watch?v=dQw4w9WgXcQ').success).toBe(true);
		expect(campaignVideoSchema.safeParse('https://evil.test/x').success).toBe(false);
		const prize = { kind: 'vehicle', title: 'Moto', declaredValueMinor: 1, quantity: 1, alternatesCount: 1 };
		expect(prizeInputSchema.safeParse(prize).success).toBe(true);
		expect(prizeInputSchema.safeParse({ ...prize, video: uploaded }).success).toBe(true);
		expect(prizeInputSchema.safeParse({ ...prize, video: null }).success).toBe(true);
		expect(prizeInputSchema.safeParse({ ...prize, video: `media:${org}/${sha}.png` }).success).toBe(false);
	});

	it('resolves an upload to its public URL and a YouTube link to the privacy-enhanced embed', () => {
		const toUrl = (path: string) => `https://cdn.test/${path}`;
		expect(resolveVideo(uploaded, toUrl)).toEqual({ kind: 'upload', url: `https://cdn.test/${org}/${sha}.mp4`, contentType: 'video/mp4' });
		expect(resolveVideo(`media:${org}/${sha}.webm`, toUrl)).toEqual({ kind: 'upload', url: `https://cdn.test/${org}/${sha}.webm`, contentType: 'video/webm' });
		expect(resolveVideo('https://youtu.be/dQw4w9WgXcQ', toUrl)).toEqual({ kind: 'youtube', embedUrl: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ' });
		expect(resolveVideo(null, toUrl)).toBeNull();
		expect(resolveVideo('https://evil.test/x.mp4', toUrl)).toBeNull();
		expect(resolveVideo(`media:${org}/${sha}.jpg`, toUrl)).toBeNull();
	});

	it('lets a prize video change after the campaign opens: it shows the prize, it does not change it', () => {
		expect(prizeChangeAllowed('draft', ['title', 'video'])).toBe(true);
		expect(prizeChangeAllowed('open', ['video'])).toBe(true);
		expect(prizeChangeAllowed('awarding', ['video'])).toBe(true);
		expect(prizeChangeAllowed('open', ['title'])).toBe(false);
		expect(prizeChangeAllowed('open', ['video', 'declaredValueMinor'])).toBe(false);
		expect(prizeChangeAllowed('archived', ['video'])).toBe(false);
	});

	it('takes a library image, a same-site path or an https URL as the prize image, never a video', () => {
		const prize = { kind: 'vehicle', title: 'Moto', declaredValueMinor: 1, quantity: 1, alternatesCount: 1 };
		for (const imageUrl of [`media:${org}/${sha}.jpg`, `media:${org}/${sha}.webp`, '/tenants/motogarage/premios/moto.jpg', 'https://cdn.test/moto.jpg', null]) {
			expect(prizeInputSchema.safeParse({ ...prize, imageUrl }).success, String(imageUrl)).toBe(true);
		}
		for (const imageUrl of [uploaded, `media:${org}/x.jpg`, '//evil.test/moto.jpg', 'http://cdn.test/moto.jpg']) {
			expect(prizeInputSchema.safeParse({ ...prize, imageUrl }).success, imageUrl).toBe(false);
		}
	});

	it('lets the prize image change after the campaign opens, like the video, but not with the rules', () => {
		expect(prizeChangeAllowed('open', ['imageUrl'])).toBe(true);
		expect(prizeChangeAllowed('closed', ['imageUrl', 'video'])).toBe(true);
		expect(prizeChangeAllowed('open', ['imageUrl', 'title'])).toBe(false);
		expect(prizeChangeAllowed('archived', ['imageUrl'])).toBe(false);
	});
});
