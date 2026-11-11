import { isMediaStoragePath } from '@sortea/domain';

/**
 * Files live in the private S3 bucket and are reached through presigned URLs
 * the API signs (ADR 0020, "Files"). The web redirects only to the origin the
 * files are served from (`MEDIA_PUBLIC_ORIGIN`), so a wrong or tampered API
 * answer can never send a visitor anywhere else.
 */
export function storageRedirect(location: string, filesOrigin: string): string | null {
	let url: URL;
	let allowed: URL;
	try {
		url = new URL(location);
		allowed = new URL(filesOrigin);
	} catch {
		return null;
	}
	if (url.username || url.password || !['https:', 'http:'].includes(url.protocol)) return null;
	return url.origin === allowed.origin ? url.href : null;
}

export type MediaSignResult =
	| { ok: true; status: number; data: { url: string; maxAgeSeconds: number } }
	| { ok: false; status: number; code: string; message: string };

function plain(status: number, body: string): Response {
	return new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
}

/**
 * `/media/<path>`: a library image or video of this site. The redirect is
 * cached until the API's signing window ends, and within it the URL is always
 * the same, so browsers keep the file too. Videos play from the bucket, which
 * answers their `Range` requests.
 */
export async function mediaRedirect(key: string, sign: (key: string) => Promise<MediaSignResult>, filesOrigin: string): Promise<Response> {
	if (!isMediaStoragePath(key)) return plain(404, 'Archivo no encontrado');
	const result = await sign(key);
	if (!result.ok) return plain(result.status === 404 ? 404 : result.status >= 500 ? result.status : 502, result.status === 404 ? 'Archivo no encontrado' : 'El archivo no está disponible en este momento');
	const location = storageRedirect(result.data.url, filesOrigin);
	if (!location) return plain(502, 'El archivo no está disponible en este momento');
	return new Response(null, { status: 302, headers: { location, 'cache-control': `public, max-age=${Math.max(0, Math.floor(result.data.maxAgeSeconds))}` } });
}
