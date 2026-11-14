import { error } from '@sveltejs/kit';
import { candidateListRound, prizeDrawListFile, tiradaSequence } from '#lib/app-draw.js';
import { serverEnv } from '#lib/server/config.js';
import type { RequestHandler } from './$types';

/**
 * The candidate coupons of one drand-backed tirada of an `app` prize as plain text, byte for
 * byte as the API stored and hashed them (ADR 0026 §6; odd/tasks/draw-room.md T9), so
 * `sha256sum` of the download equals the tirada's published SHA-256 and
 * `scripts/verify-app-draw.mjs` recomputes its winners from it. Numbers only, no names.
 */
export const GET: RequestHandler = async ({ params, url }) => {
	const round = candidateListRound(params.round);
	const sequence = tiradaSequence(params.sequence);
	if (round === null || sequence === null) error(404, 'Esa tirada del sorteo en la app no existe');
	const response = await fetch(`${serverEnv('API_INTERNAL_URL')}/public/campaigns/${encodeURIComponent(params.slug)}/app-draws/${round}/prizes/${sequence}/candidates.txt`, {
		headers: { 'x-internal-token': serverEnv('INTERNAL_API_TOKEN'), 'x-tenant-host': url.hostname }
	});
	if (!response.ok) error(404, 'Esa tirada del sorteo en la app no existe');
	return new Response(await response.arrayBuffer(), {
		headers: {
			'content-type': 'text/plain; charset=utf-8',
			'content-disposition': `attachment; filename="${prizeDrawListFile(params.slug, round, sequence)}"`,
			'x-content-sha256': response.headers.get('x-content-sha256') ?? '',
			// A tirada is append-only: the file never changes.
			'cache-control': 'public, max-age=3600'
		}
	});
};
