import { describe, expect, it } from 'vitest';
import { PRIZE_GALLERY_MAX, prizeChangeAllowed, prizeGallerySchema, prizeInputSchema } from '../src';

// owner-feedback-2026-11-14 S7: a prize shows an ordered gallery of photos and videos, like a product page.
const org = '0f0e0d0c-0b0a-4908-8706-050403020100';
const image = `media:${org}/${'a'.repeat(64)}.jpg`;
const video = `media:${org}/${'b'.repeat(64)}.mp4`;

describe('prize gallery', () => {
	it('keeps images and videos in the given order, from the library or the same site', () => {
		const items = [
			{ kind: 'image', url: '/tenants/demo/premios/moto.jpg', alt: 'La moto en el taller' },
			{ kind: 'video', url: '/tenants/demo/premios/moto.mp4', alt: 'Video de la moto' },
			{ kind: 'image', url: image, alt: 'Detalle del tanque' },
			{ kind: 'video', url: video, alt: 'La moto en marcha' },
			{ kind: 'image', url: 'https://example.com/moto.webp', alt: 'Vista lateral' }
		];
		expect(prizeGallerySchema.parse(items)).toEqual(items);
		expect(prizeInputSchema.partial().parse({ gallery: items })).toEqual({ gallery: items });
	});

	it('refuses an item without an alt text, a video where an image goes and the reverse, a YouTube link and other sites’ videos', () => {
		const refused = [
			{ kind: 'image', url: '/a.jpg', alt: '' },
			{ kind: 'image', url: video, alt: 'Video como foto' },
			{ kind: 'video', url: image, alt: 'Foto como video' },
			{ kind: 'video', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', alt: 'YouTube' },
			{ kind: 'video', url: 'https://example.com/moto.mp4', alt: 'Otro sitio' },
			{ kind: 'video', url: '/tenants/demo/moto.jpg', alt: 'No es un video' },
			{ kind: 'audio', url: '/a.mp3', alt: 'Audio' }
		];
		for (const item of refused) expect(prizeGallerySchema.safeParse([item]).success, JSON.stringify(item)).toBe(false);
	});

	it('holds at most PRIZE_GALLERY_MAX items', () => {
		const item = { kind: 'image', url: '/a.jpg', alt: 'Foto' };
		expect(prizeGallerySchema.safeParse(Array(PRIZE_GALLERY_MAX).fill(item)).success).toBe(true);
		expect(prizeGallerySchema.safeParse(Array(PRIZE_GALLERY_MAX + 1).fill(item)).success).toBe(false);
	});

	it('only shows the prize, so it can change after the campaign opens, like the image and the video', () => {
		expect(prizeChangeAllowed('open', ['gallery'])).toBe(true);
		expect(prizeChangeAllowed('awarding', ['gallery', 'imageUrl'])).toBe(true);
		expect(prizeChangeAllowed('open', ['gallery', 'title'])).toBe(false);
		expect(prizeChangeAllowed('archived', ['gallery'])).toBe(false);
	});
});
