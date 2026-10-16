import { VIDEO_MAX_BYTES } from '@sortea/domain';

/**
 * Request body limits of the web tier (ADR 0009). adapter-node has one
 * server-wide limit (`BODY_SIZE_LIMIT`), set high enough for a video; this
 * guard, run first in `handle`, keeps every other route at the 3 MB they had
 * before, so only the video upload of the site library can send 50 MB.
 */
export const DEFAULT_BODY_LIMIT = 3 * 1024 * 1024;
/** A 50 MB video plus the multipart envelope around it. */
export const VIDEO_UPLOAD_BODY_LIMIT = VIDEO_MAX_BYTES + 1024 * 1024;

const VIDEO_UPLOAD = { pathname: '/admin/sitio', action: 'uploadVideo' };

interface BodyRequest {
	method: string;
	url: URL;
	headers: Headers;
}

/** The form action SvelteKit runs: the first query key starting with `/` (kit's `call_action`), else `default`. */
function formAction(url: URL): string {
	for (const key of url.searchParams.keys()) if (key.startsWith('/')) return key.slice(1);
	return 'default';
}

function isVideoUpload({ method, url }: BodyRequest): boolean {
	return method === 'POST' && url.pathname === VIDEO_UPLOAD.pathname && formAction(url) === VIDEO_UPLOAD.action;
}

function limitFor(request: BodyRequest): number {
	return isVideoUpload(request) ? VIDEO_UPLOAD_BODY_LIMIT : DEFAULT_BODY_LIMIT;
}

/** Why a request body is refused before anyone reads it, or null when it may go on. */
export function bodyRejection(request: BodyRequest): { status: 400 | 411 | 413; message: string } | null {
	const length = request.headers.get('content-length');
	if (length === null) {
		// Browsers send the length of forms and files; a streamed body could grow up to the server-wide limit.
		return request.headers.has('transfer-encoding') ? { status: 411, message: 'Falta el tamaño del envío' } : null;
	}
	if (!/^\d+$/.test(length)) return { status: 400, message: 'Envío inválido' };
	if (Number(length) > limitFor(request)) return { status: 413, message: 'El archivo o los datos enviados son demasiado grandes' };
	return null;
}

/**
 * The large body may only be read for a real admin who manages the site. The
 * session cookie alone proves nothing (the web decodes it without checking the
 * signature), so `session` asks the API, which verifies it; null means no valid
 * session. Runs before the body is read.
 */
export async function videoUploaderRejection(
	request: BodyRequest,
	session: () => Promise<{ permissions: string[] } | null>
): Promise<{ status: 401 | 403; message: string } | null> {
	if (!isVideoUpload(request)) return null;
	const current = await session();
	if (!current) return { status: 401, message: 'Iniciá sesión para subir videos' };
	if (!current.permissions.includes('cms.manage')) return { status: 403, message: 'No tenés permiso para subir videos' };
	return null;
}
