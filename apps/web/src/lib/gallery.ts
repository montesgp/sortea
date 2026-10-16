import type { GalleryContent, SiteData } from './server/types';

/** The gallery page exists only while the block is published, enabled and has photos. */
export function visibleGallery(content: SiteData['content']): GalleryContent | null {
	const gallery = content.gallery;
	return gallery?.enabled && gallery.items.length ? gallery : null;
}

/** The home teaser, on top of a visible page, needs its own switch. */
export function galleryOnHome(content: SiteData['content']): GalleryContent | null {
	const gallery = visibleGallery(content);
	return gallery?.showOnHome ? gallery : null;
}

/** The menu link, on top of a visible page, needs its own switch. */
export function galleryInMenu(content: SiteData['content']): GalleryContent | null {
	const gallery = visibleGallery(content);
	return gallery?.showInMenu ? gallery : null;
}

/** The site a credited photo comes from, as the credit line names it. */
export function sourceName(url: string): string {
	try {
		const host = new URL(url).hostname.replace(/^www\./, '');
		return host === 'commons.wikimedia.org' ? 'Wikimedia Commons' : host;
	} catch {
		return 'fuente';
	}
}
