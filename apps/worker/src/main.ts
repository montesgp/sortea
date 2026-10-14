import { hostname } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { createDatabase } from '@sortea/db';
import { parseKeyRing } from '@sortea/domain/server';
import { z } from 'zod';
import { createLogProvider, createResendProvider, createSmtpProvider, type NotificationProvider } from './notifications';
import { claimBatch, expireOrders, processEvent, pruneOpsEvents, type WorkerDeps } from './processor';
import { createReconciliationTrigger } from './reconciliation';

const config = z
	.object({
		NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
		DATABASE_URL: z.string().min(1),
		SECRETS_KEY_RING: z.string().min(1),
		LOOKUP_PEPPER: z.string().min(16),
		WEB_FALLBACK_ORIGIN: z.url(),
		EMAIL_PROVIDER: z.enum(['smtp', 'resend', 'log']).default('log'),
		EMAIL_FROM_DOMAIN: z.string().min(3),
		SMTP_HOST: z.string().default('127.0.0.1'),
		SMTP_PORT: z.coerce.number().int().default(54325),
		RESEND_API_KEY: z.string().optional(),
		WORKER_POLL_MS: z.coerce.number().int().min(250).default(1500),
		// Scheduled payment reconciliation runs in the API; the worker only calls it.
		API_INTERNAL_URL: z.url().optional(),
		INTERNAL_API_TOKEN: z.string().min(16).optional(),
		RECONCILE_INTERVAL_MINUTES: z.coerce.number().int().min(5).max(1440).default(30)
	})
	.parse(process.env);

if (config.NODE_ENV === 'production' && (!config.API_INTERNAL_URL || !config.INTERNAL_API_TOKEN)) {
	throw new Error('API_INTERNAL_URL and INTERNAL_API_TOKEN are required in production: payment reconciliation depends on them');
}

function emailProvider(): NotificationProvider {
	if (config.EMAIL_PROVIDER === 'resend') {
		if (!config.RESEND_API_KEY) throw new Error('RESEND_API_KEY is required when EMAIL_PROVIDER=resend');
		return createResendProvider(config.RESEND_API_KEY);
	}
	if (config.EMAIL_PROVIDER === 'smtp') {
		if (config.NODE_ENV === 'production') throw new Error('The SMTP provider is for local development only');
		return createSmtpProvider(config.SMTP_HOST, config.SMTP_PORT);
	}
	return createLogProvider();
}

const db = createDatabase(config.DATABASE_URL, { max: 4 });
const deps: WorkerDeps = {
	db,
	keyRing: parseKeyRing(config.SECRETS_KEY_RING),
	email: emailProvider(),
	lookupPepper: config.LOOKUP_PEPPER,
	webFallbackOrigin: config.WEB_FALLBACK_ORIGIN,
	fromDomain: config.EMAIL_FROM_DOMAIN,
	workerId: `${hostname()}:${process.pid}`,
	now: () => new Date()
};

let running = true;
const stop = () => {
	running = false;
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

const reconcile =
	config.API_INTERNAL_URL && config.INTERNAL_API_TOKEN
		? createReconciliationTrigger({ apiUrl: config.API_INTERNAL_URL, internalToken: config.INTERNAL_API_TOKEN, intervalMinutes: config.RECONCILE_INTERVAL_MINUTES })
		: null;
const RECONCILE_CHECK_MS = 5 * 60_000;

console.log(`worker ${deps.workerId} started (email: ${deps.email.name}, reconciliation: ${reconcile ? `every ${config.RECONCILE_INTERVAL_MINUTES} min` : 'off'})`);
let lastExpiry = 0;
let lastPrune = 0;
// First check 30 s after start, so a worker booting beside the API does not call it before it listens.
let lastReconcile = Date.now() - RECONCILE_CHECK_MS + 30_000;
// Reconciliation may take minutes; it runs beside the outbox loop, never twice at once.
let reconciling: Promise<void> | null = null;
while (running) {
	try {
		if (Date.now() - lastExpiry > 60_000) {
			const expired = await expireOrders(deps);
			if (expired) console.log(`expired ${expired} unpaid orders`);
			lastExpiry = Date.now();
		}
		if (Date.now() - lastPrune > 3_600_000) {
			const pruned = await pruneOpsEvents(deps);
			if (pruned) console.log(`pruned ${pruned} old dashboard events`);
			lastPrune = Date.now();
		}
		if (reconcile && !reconciling && Date.now() - lastReconcile > RECONCILE_CHECK_MS) {
			lastReconcile = Date.now();
			reconciling = reconcile()
				.then((result) => console.log(`reconciliation: ${result}`))
				.catch((error) => console.error('reconciliation trigger failed', error instanceof Error ? error.message : error))
				.finally(() => {
					reconciling = null;
				});
		}
		const batch = await claimBatch(deps);
		for (const event of batch) {
			const result = await processEvent(deps, event);
			console.log(`outbox ${event.topic} ${event.id} -> ${result} (attempt ${event.attempts})`);
		}
		if (batch.length === 0) await sleep(config.WORKER_POLL_MS);
	} catch (error) {
		console.error('worker loop error', error instanceof Error ? error.message : error);
		await sleep(5_000);
	}
}
await reconciling;
await db.close();
console.log('worker stopped');
