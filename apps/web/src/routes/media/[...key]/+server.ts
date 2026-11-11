import { api } from '#lib/server/api.js';
import { serverEnv } from '#lib/server/config.js';
import { mediaRedirect } from '#lib/storage-redirect.js';
import type { RequestHandler } from './$types';

/** Library images and videos of this site: a redirect to the bucket (ADR 0020, "Files"). */
export const GET: RequestHandler = async (event) =>
	mediaRedirect(event.params.key, (key) => api<{ url: string; maxAgeSeconds: number }>(event, `/public/media/${key}`), serverEnv('MEDIA_PUBLIC_ORIGIN'));
