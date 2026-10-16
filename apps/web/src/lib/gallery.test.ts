import { describe, expect, it } from 'vitest';
import { galleryInMenu, galleryOnHome, sourceName, visibleGallery } from './gallery';
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

	it('names the site a credited photo comes from', () => {
		expect(sourceName(gallery.items[0]!.credit!.sourceUrl)).toBe('Wikimedia Commons');
		expect(sourceName('https://www.flickr.com/photos/x')).toBe('flickr.com');
	});
});
