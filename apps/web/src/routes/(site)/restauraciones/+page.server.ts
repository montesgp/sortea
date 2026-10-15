import { error } from '@sveltejs/kit';
import { visibleGallery } from '#lib/gallery.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const gallery = locals.site ? visibleGallery(locals.site.content) : null;
	if (!gallery) error(404, 'Página no encontrada');
	return { gallery };
};
