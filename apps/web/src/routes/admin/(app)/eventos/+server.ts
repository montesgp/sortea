import { adminToken } from '#lib/server/admin-session.js';
import { serverEnv } from '#lib/server/config.js';
import type { RequestHandler } from './$types';

/**
 * Same-origin event stream for the dashboard (ADR 0007). The browser
 * authenticates with its session cookie; this endpoint forwards the stream
 * from the API with the internal token, so neither the API nor any token is
 * exposed. Closing the page aborts the upstream request.
 */
export const GET: RequestHandler = async (event) => {
	const token = await adminToken(event.cookies);
	if (!token) return new Response(null, { status: 401 });

	const headers: Record<string, string> = {
		'x-internal-token': serverEnv('INTERNAL_API_TOKEN'),
		'x-tenant-host': event.url.hostname,
		'x-client-ip': event.getClientAddress(),
		authorization: `Bearer ${token}`,
		accept: 'text/event-stream'
	};
	const lastEventId = event.request.headers.get('last-event-id');
	if (lastEventId && /^\d{1,15}$/.test(lastEventId)) headers['last-event-id'] = lastEventId;
	const after = event.url.searchParams.get('after');
	const query = after && /^\d{1,15}$/.test(after) ? `?after=${after}` : '';

	let upstream: Response;
	try {
		upstream = await fetch(`${serverEnv('API_INTERNAL_URL')}/admin/events${query}`, { headers, signal: event.request.signal });
	} catch {
		return new Response(null, { status: 503 });
	}
	if (!upstream.ok || !upstream.body) {
		await upstream.body?.cancel();
		return new Response(null, { status: upstream.status });
	}
	return new Response(upstream.body, {
		headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' }
	});
};
