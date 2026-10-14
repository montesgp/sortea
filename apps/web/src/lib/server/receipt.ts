import { dev } from '$app/env';
import type { Cookies } from '@sveltejs/kit';

/** Remembers the last purchase on this browser so the return page can show its status. */
const RECEIPT = 'sortea_receipt';

export interface Receipt {
	reference: string;
	accessCode: string;
}

export function saveReceipt(cookies: Cookies, receipt: Receipt) {
	cookies.set(RECEIPT, JSON.stringify(receipt), { path: '/', httpOnly: true, secure: !dev, sameSite: 'lax', maxAge: 60 * 60 * 6 });
}

export function readReceipt(cookies: Cookies): Receipt | null {
	try {
		const value = JSON.parse(cookies.get(RECEIPT) ?? 'null') as Receipt | null;
		return value && typeof value.reference === 'string' && typeof value.accessCode === 'string' ? value : null;
	} catch {
		return null;
	}
}
