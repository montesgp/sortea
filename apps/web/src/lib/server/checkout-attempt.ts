import { dev } from '$app/env';
import type { Cookies } from '@sveltejs/kit';
import { z } from 'zod';
import { readReceipt } from './receipt.js';

/**
 * Each checkout page carries a random attempt id. Once an order is created for
 * it, this browser remembers the attempt as done, so the same page sent again
 * (the browser's Back button, a second click) never creates a second order
 * (owner feedback 2026-10-30). Only the latest few attempts are kept.
 */
const DONE = 'sortea_checkout_done';
const KEEP = 5;
const attemptSchema = z.uuid();
const doneSchema = z.array(z.object({ attempt: z.uuid(), reference: z.string().min(1).max(40) })).max(KEEP);
type Done = z.infer<typeof doneSchema>[number];

/** Why a checkout page no longer takes orders; `reference` is set when this browser can show that purchase. */
export interface ClosedCheckout {
	reason: 'done' | 'empty';
	reference: string | null;
}

export const newCheckoutAttempt = (): string => crypto.randomUUID();

export function checkoutAttempt(value: unknown): string | null {
	const parsed = attemptSchema.safeParse(value);
	return parsed.success ? parsed.data : null;
}

function readDone(cookies: Cookies): Done[] {
	try {
		const parsed = doneSchema.safeParse(JSON.parse(cookies.get(DONE) ?? '[]'));
		return parsed.success ? parsed.data : [];
	} catch {
		return [];
	}
}

export function markCheckoutDone(cookies: Cookies, attempt: string, reference: string) {
	const kept = [{ attempt, reference }, ...readDone(cookies).filter((done) => done.attempt !== attempt)].slice(0, KEEP);
	// Lives as long as the receipt it points to.
	cookies.set(DONE, JSON.stringify(kept), { path: '/', httpOnly: true, secure: !dev, sameSite: 'lax', maxAge: 60 * 60 * 6 });
}

function closed(cookies: Cookies, done: Done): ClosedCheckout {
	// The result page shows only the purchase in the receipt cookie.
	return { reason: 'done', reference: readReceipt(cookies)?.reference === done.reference ? done.reference : null };
}

export function checkoutDone(cookies: Cookies, attempt: string): ClosedCheckout | null {
	const done = readDone(cookies).find((candidate) => candidate.attempt === attempt);
	return done ? closed(cookies, done) : null;
}

export function lastCheckoutDone(cookies: Cookies): ClosedCheckout | null {
	const [done] = readDone(cookies);
	return done ? closed(cookies, done) : null;
}
