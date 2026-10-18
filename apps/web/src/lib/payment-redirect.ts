/**
 * Where the checkout may send the buyer to pay. SvelteKit 3 refuses a
 * redirect to another origin unless it is allowed, so the API's payment URL is
 * checked here and only that one origin is allowed: Mercado Pago over https
 * (production and sandbox), or the site itself, where the local payment
 * simulator lives. Anything else is refused, never followed.
 */
const PAYMENT_DOMAINS = ['mercadopago.com.ar', 'mercadopago.com'];

export function paymentRedirect(location: string, siteOrigin: string): { location: string; external: string[] } | null {
	let url: URL;
	try {
		url = new URL(location);
	} catch {
		return null;
	}
	if (url.origin === new URL(siteOrigin).origin) return { location, external: [url.origin] };
	if (url.protocol !== 'https:' || url.username || url.password) return null;
	const host = url.hostname.toLowerCase();
	return PAYMENT_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`)) ? { location, external: [url.origin] } : null;
}
