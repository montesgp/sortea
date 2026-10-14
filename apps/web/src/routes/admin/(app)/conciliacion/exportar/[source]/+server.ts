import { error } from '@sveltejs/kit';
import { adminApi } from '#lib/server/admin.js';
import type { RequestHandler } from './$types';

const sources = new Set(['system', 'provider', 'settlements', 'items']);
const names: Record<string, string> = { system: 'plataforma', provider: 'mercadopago', settlements: 'liquidaciones', items: 'diferencias' };

/** Streams the API's CSV export to the admin's browser; the API applies the permission and the audit. */
export const GET: RequestHandler = async (event) => {
	const { source } = event.params;
	if (!sources.has(source)) error(404, 'Exportación no encontrada');
	const query = new URLSearchParams();
	for (const key of ['from', 'to']) {
		const value = event.url.searchParams.get(key);
		if (value) query.set(key, value);
	}
	const result = await adminApi<string>(event, `/admin/reconciliation/export/${source}?${query}`);
	if (!result.ok) error(result.status, result.message);
	const day = new Date().toISOString().slice(0, 10);
	return new Response(result.data, {
		headers: {
			'content-type': 'text/csv; charset=utf-8',
			'content-disposition': `attachment; filename="conciliacion-${names[source]}-${day}.csv"`,
			'cache-control': 'no-store'
		}
	});
};
