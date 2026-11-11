/**
 * The web's health check for the platform (README, "Deploy"): `/healthz`
 * answers before anything else in `handle`, so it never calls the API or
 * resolves a site. It only says the process serves requests.
 */
export function healthResponse(method: string, pathname: string): Response | null {
	if (pathname !== '/healthz' || (method !== 'GET' && method !== 'HEAD')) return null;
	return new Response('ok', { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
}
