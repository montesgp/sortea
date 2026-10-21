import { error } from '@sveltejs/kit';
import { manifestRound } from '#lib/quiniela.js';
import { serverEnv } from '#lib/server/config.js';
import type { RequestHandler } from './$types';

/** Streams a published manifest byte for byte so its SHA-256 can be recomputed (AC-11): `?ronda=N` for a round's, else the latest (ADR 0014 §5). */
export const GET: RequestHandler = async ({ params, url }) => {
	const round = manifestRound(url.searchParams.get('ronda'));
	const query = round === null ? '' : `?round=${round}`;
	const response = await fetch(`${serverEnv('API_INTERNAL_URL')}/public/campaigns/${encodeURIComponent(params.slug)}/manifest${query}`, {
		headers: { 'x-internal-token': serverEnv('INTERNAL_API_TOKEN'), 'x-tenant-host': url.hostname }
	});
	if (!response.ok) error(404, 'El manifiesto todavía no fue publicado');
	return new Response(await response.arrayBuffer(), {
		headers: {
			'content-type': 'application/x-ndjson; charset=utf-8',
			'content-disposition': `attachment; filename="${params.slug}-manifiesto${round === null ? '' : `-ronda-${round}`}.ndjson"`,
			'x-content-sha256': response.headers.get('x-content-sha256') ?? '',
			'cache-control': 'public, max-age=300'
		}
	});
};
