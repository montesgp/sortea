import { error } from '@sveltejs/kit';
import { renderMarkdown } from '#lib/markdown.js';
import type { PageServerLoad } from './$types';

const documents = {
	terminos: { title: 'Términos y condiciones de venta', versionKey: 'termsVersion', block: 'legal.terms' },
	privacidad: { title: 'Privacidad y datos personales', versionKey: 'privacyVersion', block: 'legal.privacy' }
} as const;

export const load: PageServerLoad = async ({ params, locals }) => {
	const doc = documents[params.doc as keyof typeof documents];
	if (!doc || !locals.site) error(404, 'Documento no encontrado');
	// Published by the organization in the CMS; until then the page shows the platform's draft notice.
	const published = locals.site.content[doc.block];
	return {
		title: doc.title,
		version: locals.site.legal[doc.versionKey],
		kind: params.doc,
		sections: published?.sections.map((section) => ({ title: section.title, html: renderMarkdown(section.body) })) ?? null
	};
};
