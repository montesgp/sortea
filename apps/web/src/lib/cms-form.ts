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
				ctaBody: optional(form, 'ctaBody')
			};
		case 'seo':
			return { title: text(form, 'title'), description: text(form, 'description'), image: optional(form, 'image') };
		case 'announcement':
			return { enabled: form.get('enabled') === 'on', text: text(form, 'text'), linkUrl: optional(form, 'linkUrl'), linkLabel: optional(form, 'linkLabel') };
		case 'legal.terms':
		case 'legal.privacy':
			return { version: text(form, 'version'), sections: rows(form, 'sections') };
	}
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
	sections: 'Secciones'
};

/** First content problem reported by the API, named in the editor's terms. */
export function contentIssue(details: unknown, fallback: string): string {
	const issue = (details as { issues?: { path: string; message: string }[] } | undefined)?.issues?.[0];
	if (!issue) return fallback;
	const [field = '', row, part] = issue.path.split('.');
	let label = fieldLabels[field] ?? field;
	if (row !== undefined && /^\d+$/.test(row)) label += `, fila ${Number(row) + 1}${part ? ` (${part === 'body' ? 'texto' : 'título'})` : ''}`;
	return label ? `${label}: ${issue.message}` : issue.message;
}
