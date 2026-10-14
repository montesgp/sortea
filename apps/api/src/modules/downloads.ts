import { and, eq, gt, schema as s, sql } from '@sortea/db';
import { downloadTokenHash } from '@sortea/domain/server';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ApiError } from '../lib/errors';
import { requireTenant } from '../lib/tenant';

const params = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{20,100}$/) });
const SIGNED_URL_SECONDS = 60;

/**
 * Exchanges a download grant for a one-minute signed storage URL (FR-COM-05).
 * Grants expire and carry a download cap, so a forwarded link stops working.
 */
export async function downloadRoutes(app: FastifyInstance) {
	const { deps } = app;

	app.get('/downloads/:token', { config: { rateLimit: { max: 30, timeWindow: '10 minutes' } } }, async (request) => {
		const tenant = await requireTenant(request);
		const parsed = params.safeParse(request.params);
		if (!parsed.success) throw unavailable();
		const tokenHash = downloadTokenHash(deps.config.LOOKUP_PEPPER, parsed.data.token);

		const asset = await deps.db.withTenant(tenant.id, async (tx) => {
			const [grant] = await tx
				.update(s.downloadGrants)
				.set({ downloadCount: sql`${s.downloadGrants.downloadCount} + 1` })
				.where(
					and(
						eq(s.downloadGrants.tokenHash, tokenHash),
						gt(s.downloadGrants.expiresAt, deps.now()),
						sql`${s.downloadGrants.downloadCount} < ${s.downloadGrants.maxDownloads}`
					)
				)
				.returning();
			if (!grant) return null;
			const [order] = await tx.select({ status: s.orders.status }).from(s.orders).where(eq(s.orders.id, grant.orderId));
			if (order?.status !== 'paid') return null;
			const [row] = await tx.select().from(s.productAssets).where(eq(s.productAssets.id, grant.productAssetId));
			return row ?? null;
		});
		if (!asset) throw unavailable();
		return { url: await deps.storage.signedUrl(asset.storagePath, SIGNED_URL_SECONDS, asset.filename), filename: asset.filename };
	});
}

function unavailable() {
	return new ApiError(410, 'download_unavailable', 'Este enlace venció o ya se usó todas las veces permitidas. Pedí uno nuevo desde Consultar');
}
