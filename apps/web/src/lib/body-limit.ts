import { PRODUCT_FILE_MAX_BYTES, VIDEO_MAX_BYTES } from '@sortea/domain';

/**
 * Request body limits of the web tier (ADR 0009). adapter-node has one
 * server-wide limit (`BODY_SIZE_LIMIT`), set high enough for a video; this
 * guard, run first in `handle`, keeps every other route at the 3 MB they had
 * before, so only the large uploads can send more: the video of the site
 * library, and the files of a digital product from its page
 * (owner-feedback-2026-11-11b, S2), each 50 MB.
 */
export const DEFAULT_BODY_LIMIT = 3 * 1024 * 1024;
/** A 50 MB video plus the multipart envelope around it. */
export const VIDEO_UPLOAD_BODY_LIMIT = VIDEO_MAX_BYTES + 1024 * 1024;
/** A 50 MB product file plus the multipart envelope around it. */
export const PRODUCT_FILE_UPLOAD_BODY_LIMIT = PRODUCT_FILE_MAX_BYTES + 1024 * 1024;

interface LargeUpload {
	pathname: RegExp;
	actions: readonly string[];
	limit: number;
	permission: string;
	signIn: string;
	forbidden: string;
}

const LARGE_UPLOADS: readonly LargeUpload[] = [
	{
		pathname: /^\/admin\/sitio$/,
		actions: ['uploadVideo'],
		limit: VIDEO_UPLOAD_BODY_LIMIT,
		permission: 'cms.manage',
		signIn: 'Iniciá sesión para subir videos',
		forbidden: 'No tenés permiso para subir videos'
	},
	{
		pathname: /^\/admin\/productos\/[^/]+$/,
		actions: ['addFile', 'replaceFile'],
		limit: PRODUCT_FILE_UPLOAD_BODY_LIMIT,
		permission: 'catalog.manage',
		signIn: 'Iniciá sesión para subir archivos',
		forbidden: 'No tenés permiso para cargar archivos de productos'
	}
];

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

function largeUpload({ method, url }: BodyRequest): LargeUpload | null {
	if (method !== 'POST') return null;
	const action = formAction(url);
	return LARGE_UPLOADS.find((upload) => upload.pathname.test(url.pathname) && upload.actions.includes(action)) ?? null;
}

function limitFor(request: BodyRequest): number {
	return largeUpload(request)?.limit ?? DEFAULT_BODY_LIMIT;
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
 * A large body may only be read for a real admin with the permission of that
 * upload (`cms.manage` for a video, `catalog.manage` for a product file). The
 * session cookie alone proves nothing (the web decodes it without checking the
 * signature), so `session` asks the API, which verifies it; null means no valid
 * session. Runs before the body is read. `hooks.server.ts` calls it by the name
 * it had when only videos were large.
 */
export async function videoUploaderRejection(
	request: BodyRequest,
	session: () => Promise<{ permissions: string[] } | null>
): Promise<{ status: 401 | 403; message: string } | null> {
	const upload = largeUpload(request);
	if (!upload) return null;
	const current = await session();
	if (!current) return { status: 401, message: upload.signIn };
	if (!current.permissions.includes(upload.permission)) return { status: 403, message: upload.forbidden };
	return null;
}
