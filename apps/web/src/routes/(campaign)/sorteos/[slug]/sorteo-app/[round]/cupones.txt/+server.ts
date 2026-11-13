import { error } from '@sveltejs/kit';
import { candidateListFile, candidateListRound } from '#lib/app-draw.js';
import { serverEnv } from '#lib/server/config.js';
import type { RequestHandler } from './$types';

/**
 * The candidate coupons of a round's in-app draw as plain text, byte for byte as the API
 * stored and hashed them (ADR 0024 §6; odd/tasks/owner-feedback-2026-11-11b.md T13), so
 * `sha256sum` of the download equals the published SHA-256. Numbers only, no names.
 */
export const GET: RequestHandler = async ({ params, url }) => {
	const round = candidateListRound(params.round);
	if (round === null) error(404, 'Ese sorteo en la app no existe');
	const response = await fetch(`${serverEnv('API_INTERNAL_URL')}/public/campaigns/${encodeURIComponent(params.slug)}/app-draws/${round}/candidates.txt`, {
		headers: { 'x-internal-token': serverEnv('INTERNAL_API_TOKEN'), 'x-tenant-host': url.hostname }
	});
	if (!response.ok) error(404, 'Ese sorteo en la app no existe');
	return new Response(await response.arrayBuffer(), {
		headers: {
			'content-type': 'text/plain; charset=utf-8',
			'content-disposition': `attachment; filename="${candidateListFile(params.slug, round)}"`,
			'x-content-sha256': response.headers.get('x-content-sha256') ?? '',
			// The in-app draw record is append-only: the file never changes.
			'cache-control': 'public, max-age=3600'
		}
	});
};
