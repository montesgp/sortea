import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

const documents = {
	terminos: { title: 'Términos y condiciones de venta', versionKey: 'termsVersion' },
	privacidad: { title: 'Privacidad y datos personales', versionKey: 'privacyVersion' }
} as const;

export const load: PageServerLoad = async ({ params, locals }) => {
	const doc = documents[params.doc as keyof typeof documents];
	if (!doc || !locals.site) error(404, 'Documento no encontrado');
	return { title: doc.title, version: locals.site.legal[doc.versionKey], kind: params.doc };
};
