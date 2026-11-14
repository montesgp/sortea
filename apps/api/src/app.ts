import { timingSafeEqual } from 'node:crypto';
import rateLimit from '@fastify/rate-limit';
import { sql } from '@sortea/db';
import Fastify, { type FastifyInstance } from 'fastify';
import type { AppDeps } from './context';
import { ApiError, errorHandler } from './lib/errors';
import { createTenantResolver, type TenantResolver } from './lib/tenant';
import { adminRoutes } from './modules/admin';
import { appDrawRoutes } from './modules/app-draw';
import { appPrizeDrawRoutes } from './modules/app-prize-draw';
import { authRoutes } from './modules/auth';
import { awardRoutes } from './modules/awards';
import { catalogAdminRoutes } from './modules/catalog-admin';
import { checkoutRoutes } from './modules/checkout';
import { couponLookupRoutes } from './modules/coupon-lookup';
import { cmsRoutes } from './modules/cms';
import { drawRoomRoutes } from './modules/draw-room';
import { downloadRoutes } from './modules/downloads';
import { geoRoutes } from './modules/geo';
import { liveRoutes } from './modules/live';
import { mediaRoutes } from './modules/media';
import { clientKey, lookupRoutes } from './modules/lookup';
import { platformRoutes } from './modules/platform';
import { publicRoutes } from './modules/public';
import { reconciliationRoutes } from './modules/reconciliation';
import { simulatorRoutes } from './modules/simulator';
import { trackingLinkRoutes } from './modules/tracking-links';
import { webhookRoutes } from './modules/webhooks';
import { createOpsHub } from './realtime/hub';

declare module 'fastify' {
	interface FastifyInstance {
		deps: AppDeps;
		tenants: TenantResolver;
		/** Every route as registered, for the test that walks the admin routes with a draw host (draw-room T4). */
		registeredRoutes: { method: string; url: string }[];
	}
}

/** Routes reachable without the internal token: provider callbacks and the health check. */
function isPublicRoute(url: string): boolean {
	const path = url.split('?')[0];
	return url.startsWith('/webhooks/') || path === '/health';
}

/** Longest the health check waits for the database before it reports it down. */
const HEALTH_TIMEOUT_MS = 3_000;

export async function buildApp(
	deps: AppDeps,
	options: { logger?: boolean | { stream: { write(line: string): void } }; live?: { lifetimeMs?: number; heartbeatMs?: number } } = {}
): Promise<FastifyInstance> {
	const app = Fastify({
		logger: options.logger
			? {
					level: 'info',
					// Request logs never include bodies; headers that carry credentials are redacted.
					// The URL is logged without its query string, which can carry what staff type to find a buyer.
					serializers: {
						req: (request: { method: string; url: string; hostname?: string; ip?: string }) => ({
							method: request.method,
							url: request.url.split('?')[0],
							host: request.hostname,
							remoteAddress: request.ip
						})
					},
					redact: ['req.headers.authorization', 'req.headers["x-internal-token"]', 'req.headers["x-lookup-token"]', 'req.headers["x-signature"]'],
					...(typeof options.logger === 'object' ? { stream: options.logger.stream } : {})
				}
			: false,
		bodyLimit: 256 * 1024,
		trustProxy: true
	});
	app.decorate('deps', deps);
	app.decorate('tenants', createTenantResolver(deps.db));
	const registeredRoutes: { method: string; url: string }[] = [];
	app.decorate('registeredRoutes', registeredRoutes);
	app.addHook('onRoute', (route) => {
		for (const method of [route.method].flat()) registeredRoutes.push({ method, url: route.url });
	});
	app.setErrorHandler(errorHandler);

	const expectedToken = Buffer.from(deps.config.INTERNAL_API_TOKEN);
	app.addHook('onRequest', async (request) => {
		if (isPublicRoute(request.url)) return;
		const received = Buffer.from(String(request.headers['x-internal-token'] ?? ''));
		if (received.length !== expectedToken.length || !timingSafeEqual(received, expectedToken)) {
			throw new ApiError(401, 'internal_only', 'Not available');
		}
	});

	await app.register(rateLimit, { global: true, max: 300, timeWindow: '1 minute', keyGenerator: clientKey });

	// The platform's health check (README, "Deploy"): the database answers, or 503. No detail leaves, since it is public.
	app.get('/health', async (request, reply) => {
		let timer: NodeJS.Timeout | undefined;
		try {
			await Promise.race([
				deps.db.withPlatform((db) => db.execute(sql`select 1`)),
				new Promise((_, reject) => {
					timer = setTimeout(() => reject(new Error('database health check timed out')), HEALTH_TIMEOUT_MS);
				})
			]);
			return { ok: true };
		} catch (error) {
			request.log.warn({ err: error }, 'health check: database unreachable');
			return reply.code(503).send({ ok: false });
		} finally {
			clearTimeout(timer);
		}
	});
	await app.register(publicRoutes);
	await app.register(checkoutRoutes);
	await app.register(geoRoutes);
	await app.register(webhookRoutes);
	await app.register(lookupRoutes);
	await app.register(downloadRoutes);
	await app.register(mediaRoutes);
	await app.register(authRoutes);
	await app.register(adminRoutes);
	await app.register(awardRoutes);
	await app.register(appDrawRoutes);
	await app.register(appPrizeDrawRoutes);
	await app.register(couponLookupRoutes);
	await app.register(drawRoomRoutes);
	await app.register(catalogAdminRoutes);
	await app.register(cmsRoutes);
	await app.register(platformRoutes);
	await app.register(reconciliationRoutes);
	await app.register(trackingLinkRoutes);

	// Live dashboard feed: one LISTEN connection per process (ADR 0007).
	const hub = createOpsHub(deps.db);
	app.addHook('onReady', () => hub.start());
	app.addHook('onClose', () => hub.stop());
	await app.register(async (instance) => liveRoutes(instance, hub, options.live));
	if (deps.simulator && deps.config.NODE_ENV !== 'production') {
		const simulator = deps.simulator;
		await app.register(async (instance) => simulatorRoutes(instance, simulator));
	}
	return app;
}
