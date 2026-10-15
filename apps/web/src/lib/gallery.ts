import type { GalleryContent, SiteData } from './server/types';

/** The gallery page, its home teaser and its menu link exist only while the block is published, enabled and has photos. */
export function visibleGallery(content: SiteData['content']): GalleryContent | null {
	const gallery = content.gallery;
	return gallery?.enabled && gallery.items.length ? gallery : null;
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
