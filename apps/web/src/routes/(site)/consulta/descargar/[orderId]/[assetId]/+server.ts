import { error, redirect } from '@sveltejs/kit';
import { z } from 'zod';
import { api } from '#lib/server/api.js';
import type { RequestHandler } from './$types';

const LOOKUP = 'sortea_lookup';
const ids = z.object({ orderId: z.uuid(), assetId: z.uuid() });

/**
 * A file of a purchase, from Consultar (owner feedback 2026-11-15b S8). A plain link, like the
 * emailed one: a form posting here did nothing on an iPhone. It asks the API for a download grant
 * with the lookup session, which checks the file is the session's to download, and sends the
 * browser to /descargas/<token>, the page that serves emailed links.
 */
export const GET: RequestHandler = async (event) => {
	const token = event.cookies.get(LOOKUP);
	if (!token) redirect(303, '/consulta');
	const parsed = ids.safeParse(event.params);
	if (!parsed.success) error(404, 'Archivo no disponible');
	const result = await api<{ token: string }>(event, '/lookup/downloads', { method: 'POST', lookupToken: token, body: parsed.data });
	if (!result.ok) error(result.status === 401 ? 401 : 404, result.message);
	redirect(303, `/descargas/${result.data.token}`);
};
