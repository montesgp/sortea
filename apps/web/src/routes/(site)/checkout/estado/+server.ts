import { json } from '@sveltejs/kit';
import { checkoutAttempt, checkoutDone } from '#lib/server/checkout-attempt.js';
import type { RequestHandler } from './$types';

/**
 * Whether a checkout page already created its order (2026-10-30). The page
 * asks when the browser shows it again from its back/forward cache, or when
 * this tab sent a checkout before, and locks itself when it did.
 */
export const GET: RequestHandler = ({ url, cookies }) => {
	const attempt = checkoutAttempt(url.searchParams.get('intento'));
	return json({ closed: attempt ? checkoutDone(cookies, attempt) : null }, { headers: { 'cache-control': 'no-store' } });
};
