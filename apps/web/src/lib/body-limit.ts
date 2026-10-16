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

const VIDEO_UPLOAD = { pathname: '/admin/sitio', action: '/uploadVideo' };

interface BodyRequest {
	method: string;
	url: URL;
	headers: Headers;
}

function limitFor({ method, url }: BodyRequest): number {
	const videoUpload = method === 'POST' && url.pathname === VIDEO_UPLOAD.pathname && [...url.searchParams.keys()].includes(VIDEO_UPLOAD.action);
	return videoUpload ? VIDEO_UPLOAD_BODY_LIMIT : DEFAULT_BODY_LIMIT;
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
