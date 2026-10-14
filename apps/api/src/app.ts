import { timingSafeEqual } from 'node:crypto';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import type { AppDeps } from './context';
import { ApiError, errorHandler } from './lib/errors';
import { createTenantResolver, type TenantResolver } from './lib/tenant';
import { adminRoutes } from './modules/admin';
import { checkoutRoutes } from './modules/checkout';
import { downloadRoutes } from './modules/downloads';
import { clientKey, lookupRoutes } from './modules/lookup';
import { platformRoutes } from './modules/platform';
import { publicRoutes } from './modules/public';
import { reconciliationRoutes } from './modules/reconciliation';
import { simulatorRoutes } from './modules/simulator';
import { webhookRoutes } from './modules/webhooks';

declare module 'fastify' {
	interface FastifyInstance {
		deps: AppDeps;
		tenants: TenantResolver;
	}
}

/** Routes reachable without the internal token: provider callbacks and health. */
const publicPrefixes = ['/webhooks/', '/health'];

export async function buildApp(deps: AppDeps, options: { logger?: boolean } = {}): Promise<FastifyInstance> {
	const app = Fastify({
		logger: options.logger
			? {
					level: 'info',
					// Request logs never include bodies; headers that carry credentials are redacted.
					redact: ['req.headers.authorization', 'req.headers["x-internal-token"]', 'req.headers["x-lookup-token"]', 'req.headers["x-signature"]']
				}
			: false,
		bodyLimit: 256 * 1024,
		trustProxy: true
	});
	app.decorate('deps', deps);
	app.decorate('tenants', createTenantResolver(deps.db));
	app.setErrorHandler(errorHandler);

	const expectedToken = Buffer.from(deps.config.INTERNAL_API_TOKEN);
	app.addHook('onRequest', async (request) => {
		if (publicPrefixes.some((prefix) => request.url.startsWith(prefix))) return;
		const received = Buffer.from(String(request.headers['x-internal-token'] ?? ''));
		if (received.length !== expectedToken.length || !timingSafeEqual(received, expectedToken)) {
			throw new ApiError(401, 'internal_only', 'Not available');
		}
	});

	await app.register(rateLimit, { global: true, max: 300, timeWindow: '1 minute', keyGenerator: clientKey });

	app.get('/health', async () => ({ ok: true }));
	await app.register(publicRoutes);
	await app.register(checkoutRoutes);
	await app.register(webhookRoutes);
	await app.register(lookupRoutes);
	await app.register(downloadRoutes);
	await app.register(adminRoutes);
	await app.register(platformRoutes);
	await app.register(reconciliationRoutes);
	if (deps.simulator && deps.config.NODE_ENV !== 'production') {
		const simulator = deps.simulator;
		await app.register(async (instance) => simulatorRoutes(instance, simulator));
	}
	return app;
}
