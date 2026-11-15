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

/** One change to a prize gallery from the panel (owner-feedback-2026-11-14 S7). */
export interface GalleryEdit {
	op: 'up' | 'down' | 'remove';
	index: number;
}

/** The gallery after moving one item up or down or removing it; a move past either end changes nothing. */
export function editGallery<T>(items: readonly T[], edit: GalleryEdit): T[] {
	const next = [...items];
	const { index } = edit;
	if (!Number.isInteger(index) || index < 0 || index >= next.length) return next;
	if (edit.op === 'remove') {
		next.splice(index, 1);
		return next;
	}
	const target = edit.op === 'up' ? index - 1 : index + 1;
	if (target < 0 || target >= next.length) return next;
	[next[index], next[target]] = [next[target]!, next[index]!];
	return next;
}

/** What an address typed in the panel shows: a video when it ends in .mp4 or .webm, else a photo. */
export function galleryKindOf(url: string): 'image' | 'video' {
	return /\.(?:mp4|webm)$/i.test(url.split(/[?#]/)[0]!) ? 'video' : 'image';
}
