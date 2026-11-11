import { isMediaStoragePath } from '@sortea/domain';
import type { FastifyInstance } from 'fastify';
import { notFound } from '../lib/errors';
import { requireTenant } from '../lib/tenant';

/**
 * Presigned URL of a library image or video (ADR 0020, "Files"). The site links
 * files as `/media/<path>`; the web asks here and redirects the browser to the
 * bucket, so files never travel through our services and videos get `Range`
 * requests from the bucket itself.
 *
 * Only paths of the tenant that the host resolves to are signed, and only
 * library paths (`<organizationId>/<sha256>.<ext>` under `site-media/`): never
 * product files, backups or any other prefix. The library row is not looked up:
 * the path is a content hash, so it reveals nothing that the site does not
 * already link, and a deleted file is simply missing from the bucket.
 */
export async function mediaRoutes(app: FastifyInstance) {
	const { deps } = app;

	// A page links many files; the browser caches each redirect for its window.
	app.get('/public/media/*', { config: { rateLimit: { max: 1200, timeWindow: '1 minute' } } }, async (request) => {
		const tenant = await requireTenant(request);
		const path = (request.params as { '*': string })['*'];
		if (!isMediaStoragePath(path) || !path.startsWith(`${tenant.id}/`)) throw notFound('Archivo');
		return deps.media.signedUrl(path, deps.now());
	});
}
