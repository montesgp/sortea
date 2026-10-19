import type { CmsBlockKey } from '@sortea/domain';

/**
 * Maps the site editor forms to block content and back. The API validates the
 * content; this only collects fields, so an invalid value reaches the API and
 * comes back with a message about the right field.
 */

export interface Row {
	title: string;
	body: string;
}

const text = (form: FormData, key: string) => String(form.get(key) ?? '').trim();
const optional = (form: FormData, key: string) => text(form, key) || null;

/** Rows named `<prefix>.<n>.title|body`; fully empty rows are dropped. */
function rows(form: FormData, prefix: string): Row[] {
	const indexes = new Set<number>();
	for (const key of form.keys()) {
		const match = key.match(new RegExp(`^${prefix}\\.(\\d+)\\.(?:title|body)$`));
		if (match) indexes.add(Number(match[1]));
	}
	return [...indexes]
		.sort((a, b) => a - b)
		.map((index) => ({ title: text(form, `${prefix}.${index}.title`), body: text(form, `${prefix}.${index}.body`) }))
		.filter((row) => row.title || row.body);
}

export interface GalleryRow {
	image: string;
	alt: string;
	title: string;
	body?: string | null;
	credit?: { author: string; license: string; sourceUrl: string } | null;
}

const galleryFields = ['image', 'alt', 'title', 'body', 'author', 'license', 'sourceUrl'] as const;

/** Photos named `items.<n>.<field>`; fully empty rows are dropped and a credit with no part filled in is none. */
function galleryRows(form: FormData): GalleryRow[] {
	const indexes = new Set<number>();
	for (const key of form.keys()) {
		const match = key.match(/^items\.(\d+)\.\w+$/);
		if (match) indexes.add(Number(match[1]));
	}
	return [...indexes]
		.sort((a, b) => a - b)
		.map((index) => Object.fromEntries(galleryFields.map((field) => [field, text(form, `items.${index}.${field}`)])) as Record<(typeof galleryFields)[number], string>)
		.filter((row) => galleryFields.some((field) => row[field]))
		.map(({ image, alt, title, body, author, license, sourceUrl }) => ({
			image,
			alt,
			title,
			body: body || null,
			credit: author || license || sourceUrl ? { author, license, sourceUrl } : null
		}));
}

export function blockContentFromForm(key: CmsBlockKey, form: FormData): Record<string, unknown> {
	switch (key) {
		case 'brand':
			return { logo: optional(form, 'logo'), logoAlt: text(form, 'logoAlt'), tagline: text(form, 'tagline') };
		case 'home':
			return {
				heroStyle: text(form, 'heroStyle') || 'simple',
				processStyle: text(form, 'processStyle') || 'list',
				heroTitle: text(form, 'heroTitle'),
				heroLead: text(form, 'heroLead'),
				heroImage: optional(form, 'heroImage'),
				heroImageAlt: optional(form, 'heroImageAlt'),
				heroVideoUrl: optional(form, 'heroVideoUrl'),
				servicesTitle: optional(form, 'servicesTitle'),
				services: rows(form, 'services'),
				processTitle: optional(form, 'processTitle'),
				process: rows(form, 'process'),
				ctaTitle: optional(form, 'ctaTitle'),
				ctaBody: optional(form, 'ctaBody'),
				productIds: form.getAll('productId').map(String)
			};
		case 'seo':
			return { title: text(form, 'title'), description: text(form, 'description'), image: optional(form, 'image') };
		case 'announcement':
			return { enabled: form.get('enabled') === 'on', text: text(form, 'text'), linkUrl: optional(form, 'linkUrl'), linkLabel: optional(form, 'linkLabel') };
		case 'gallery':
			return {
				enabled: form.get('enabled') === 'on',
				showOnHome: form.get('showOnHome') === 'on',
				showInMenu: form.get('showInMenu') === 'on',
				title: text(form, 'title'),
				lead: optional(form, 'lead'),
				note: optional(form, 'note'),
				items: galleryRows(form)
			};
		case 'legal.terms':
		case 'legal.privacy':
			return { version: text(form, 'version'), sections: rows(form, 'sections') };
	}
}

/** Existing photos plus two empty rows to add more, without passing the block's limit. */
export function editableGalleryRows(existing: GalleryRow[] | undefined, max: number): GalleryRow[] {
	const current = existing ?? [];
	const empty = Math.max(0, Math.min(2, max - current.length));
	return [...current, ...Array.from({ length: empty }, () => ({ image: '', alt: '', title: '', body: null, credit: null }))];
}

/** Existing rows plus two empty ones to add more, without passing the block's limit. */
export function editableRows(existing: Row[] | undefined, max: number): Row[] {
	const current = existing ?? [];
	const empty = Math.max(0, Math.min(2, max - current.length));
	return [...current, ...Array.from({ length: empty }, () => ({ title: '', body: '' }))];
}

const fieldLabels: Record<string, string> = {
	logo: 'Logo',
	logoAlt: 'Texto alternativo del logo',
	tagline: 'Bajada',
	heroTitle: 'Título principal',
	heroLead: 'Texto principal',
	heroImage: 'Imagen principal',
	heroImageAlt: 'Descripción de la imagen',
	heroVideoUrl: 'Video',
	servicesTitle: 'Título de servicios',
	services: 'Servicios',
	processTitle: 'Título del proceso',
	process: 'Proceso',
	ctaTitle: 'Título del cierre',
	ctaBody: 'Texto del cierre',
	title: 'Título',
	description: 'Descripción',
	image: 'Imagen',
	text: 'Texto',
	linkUrl: 'Enlace',
	linkLabel: 'Texto del enlace',
	version: 'Versión',
	sections: 'Secciones',
	lead: 'Bajada',
	note: 'Aclaración',
	items: 'Fotos'
};

/** The part of a row the API rejected, by the last segment of its path. */
const partLabels: Record<string, string> = {
	title: 'título',
	body: 'texto',
	image: 'imagen',
	alt: 'descripción',
	author: 'autor',
	license: 'licencia',
	sourceUrl: 'fuente'
};

/** First content problem reported by the API, named in the editor's terms. */
export function contentIssue(details: unknown, fallback: string): string {
	const issue = (details as { issues?: { path: string; message: string }[] } | undefined)?.issues?.[0];
	if (!issue) return fallback;
	const [field = '', row, ...rest] = issue.path.split('.');
	const part = rest.at(-1);
	let label = fieldLabels[field] ?? field;
	if (row !== undefined && /^\d+$/.test(row)) label += `, fila ${Number(row) + 1}${part ? ` (${partLabels[part] ?? part})` : ''}`;
	return label ? `${label}: ${issue.message}` : issue.message;
}
