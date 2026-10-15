import { describe, expect, it } from 'vitest';
import { sourceName, visibleGallery } from './gallery';
import type { GalleryContent } from './server/types';

const gallery: GalleryContent = {
	enabled: true,
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

	it('names the site a credited photo comes from', () => {
		expect(sourceName(gallery.items[0]!.credit!.sourceUrl)).toBe('Wikimedia Commons');
		expect(sourceName('https://www.flickr.com/photos/x')).toBe('flickr.com');
	});
});
