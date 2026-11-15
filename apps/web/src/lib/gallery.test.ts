import { describe, expect, it } from 'vitest';
import { editGallery, galleryInMenu, galleryKindOf, galleryOnHome, sourceName, visibleGallery } from './gallery';
import type { GalleryContent } from './server/types';

const gallery: GalleryContent = {
	enabled: true,
	showOnHome: true,
	showInMenu: true,
	title: 'Restauraciones',
	lead: null,
	note: 'Fotos de ejemplo.',
	items: [
		{ image: '/a.jpg', alt: 'Honda', title: 'Honda CB750', body: null, credit: { author: 'Jane Doe', license: 'CC BY-SA 2.0', sourceUrl: 'https://commons.wikimedia.org/wiki/File:A.jpg' } },
		{ image: '/b.jpg', alt: 'Taller', title: 'En el taller', body: null, credit: null }
	]
};

describe('restorations gallery', () => {
	it('is shown only when published and enabled with photos', () => {
		expect(visibleGallery({ gallery })).toBe(gallery);
		expect(visibleGallery({})).toBeNull();
		expect(visibleGallery({ gallery: { ...gallery, enabled: false } })).toBeNull();
		expect(visibleGallery({ gallery: { ...gallery, items: [] } })).toBeNull();
	});

	it('reaches the home teaser and the menu only when each is turned on', () => {
		expect(galleryOnHome({ gallery })).toBe(gallery);
		expect(galleryInMenu({ gallery })).toBe(gallery);
		const pageOnly = { ...gallery, showOnHome: false, showInMenu: false };
		expect(visibleGallery({ gallery: pageOnly })).toBe(pageOnly);
		expect(galleryOnHome({ gallery: pageOnly })).toBeNull();
		expect(galleryInMenu({ gallery: pageOnly })).toBeNull();
		expect(galleryOnHome({ gallery: { ...gallery, showInMenu: false } })).not.toBeNull();
		expect(galleryInMenu({ gallery: { ...gallery, showOnHome: false } })).not.toBeNull();
		// Content published before the flags existed stays off the home and the menu.
		const { showOnHome: _home, showInMenu: _menu, ...legacy } = gallery;
		expect(galleryOnHome({ gallery: legacy as GalleryContent })).toBeNull();
		expect(galleryInMenu({ gallery: legacy as GalleryContent })).toBeNull();
		expect(galleryOnHome({ gallery: { ...gallery, enabled: false } })).toBeNull();
		expect(galleryInMenu({ gallery: { ...gallery, enabled: false } })).toBeNull();
	});

	// owner-feedback-2026-11-14 S7: a prize gallery is reordered and trimmed one item at a time.
	it('moves a prize gallery item up or down and removes one, ignoring moves past the ends', () => {
		const items = ['a', 'b', 'c'];
		expect(editGallery(items, { op: 'up', index: 1 })).toEqual(['b', 'a', 'c']);
		expect(editGallery(items, { op: 'down', index: 1 })).toEqual(['a', 'c', 'b']);
		expect(editGallery(items, { op: 'remove', index: 2 })).toEqual(['a', 'b']);
		expect(editGallery(items, { op: 'up', index: 0 })).toEqual(items);
		expect(editGallery(items, { op: 'down', index: 2 })).toEqual(items);
		expect(editGallery(items, { op: 'remove', index: 7 })).toEqual(items);
		expect(items).toEqual(['a', 'b', 'c']);
	});

	it('takes an address ending in .mp4 or .webm as a video and anything else as a photo', () => {
		expect(galleryKindOf('/tenants/demo/moto.mp4')).toBe('video');
		expect(galleryKindOf('https://example.com/a.WEBM?x=1')).toBe('video');
		expect(galleryKindOf('/tenants/demo/moto.jpg')).toBe('image');
		expect(galleryKindOf('https://example.com/mp4')).toBe('image');
	});

	it('names the site a credited photo comes from', () => {
		expect(sourceName(gallery.items[0]!.credit!.sourceUrl)).toBe('Wikimedia Commons');
		expect(sourceName('https://www.flickr.com/photos/x')).toBe('flickr.com');
	});
});
