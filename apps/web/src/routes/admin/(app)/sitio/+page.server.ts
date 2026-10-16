import { fail, redirect } from '@sveltejs/kit';
import { isCmsBlockKey, MEDIA_MAX_BYTES, VIDEO_MAX_BYTES, type CmsBlockKey } from '@sortea/domain';
import { blockContentFromForm, contentIssue } from '#lib/cms-form.js';
import { adminApi, adminLoad } from '#lib/server/admin.js';
import { adminToken } from '#lib/server/admin-session.js';
import { invalidateSite } from '#lib/server/site.js';
import type { ApiResult } from '#lib/server/api.js';
import type { Actions, PageServerLoad } from './$types';

export interface CmsBlock {
	key: CmsBlockKey;
	version: number;
	published: Record<string, unknown> | null;
	publishedAt: string | null;
	draft: Record<string, unknown> | null;
	draftUpdatedAt: string | null;
	revisions: { version: number; publishedAt: string }[];
}

export interface CmsMedia {
	id: string;
	kind: 'image' | 'video';
	ref: string;
	url: string;
	filename: string;
	contentType: string;
	sizeBytes: number;
	createdAt: string;
	inUse: boolean;
}

export interface Faq {
	id: string;
	question: string;
	answer: string;
	position: number;
}

interface Revision {
	version: number;
	publishedAt: string;
	content: Record<string, unknown>;
}

export const load: PageServerLoad = async (event) => {
	const [cms, faqs] = await Promise.all([
		adminLoad<{ blocks: CmsBlock[]; media: CmsMedia[]; legal: { termsVersion: string; privacyVersion: string } }>(event, '/admin/cms'),
		adminLoad<{ faqs: Faq[] }>(event, '/admin/faqs')
	]);
	return { ...cms, faqs: faqs.faqs };
};

type Event = Parameters<Actions[string]>[0];
const text = (form: FormData, key: string) => String(form.get(key) ?? '').trim();

/** `content` carries what was typed back to the form, so a rejected save loses nothing. */
function failure(target: string, result: Extract<ApiResult<unknown>, { ok: false }>, content?: Record<string, unknown>) {
	const details = result.details as { fieldErrors?: Record<string, string[]> } | undefined;
	const field = details?.fieldErrors && Object.values(details.fieldErrors).flat()[0];
	return fail(result.status, { target, ok: false, message: contentIssue(result.details, field ?? result.message), content });
}

function blockKeyOf(form: FormData): CmsBlockKey | null {
	const key = text(form, 'key');
	return isCmsBlockKey(key) ? key : null;
}

async function saveDraft(event: Event, key: CmsBlockKey, content: unknown) {
	return adminApi(event, `/admin/cms/blocks/${key}`, { method: 'PUT', body: { content } });
}

export const actions: Actions = {
	save: async (event) => {
		const form = await event.request.formData();
		const key = blockKeyOf(form);
		if (!key) return fail(400, { target: 'block', ok: false, message: 'Bloque desconocido' });
		const content = blockContentFromForm(key, form);
		const saved = await saveDraft(event, key, content);
		if (!saved.ok) return failure(key, saved, content);
		if (form.get('intent') !== 'publish') return { target: key, ok: true, message: 'Borrador guardado. Todavía no se ve en el sitio' };
		const published = await adminApi<CmsBlock>(event, `/admin/cms/blocks/${key}/publish`, { method: 'POST' });
		if (!published.ok) return failure(key, published);
		invalidateSite(event.url.hostname);
		return { target: key, ok: true, message: `Publicado: versión ${published.data.version}` };
	},

	discard: async (event) => {
		const form = await event.request.formData();
		const key = blockKeyOf(form);
		if (!key) return fail(400, { target: 'block', ok: false, message: 'Bloque desconocido' });
		const result = await adminApi(event, `/admin/cms/blocks/${key}/draft`, { method: 'DELETE' });
		if (!result.ok) return failure(key, result);
		return { target: key, ok: true, message: 'Borrador descartado: queda lo publicado' };
	},

	/** Copies a published version into the draft; publishing it is a separate, explicit step. */
	restore: async (event) => {
		const form = await event.request.formData();
		const key = blockKeyOf(form);
		const version = Number(text(form, 'version'));
		if (!key || !Number.isInteger(version)) return fail(400, { target: 'block', ok: false, message: 'Versión desconocida' });
		const history = await adminApi<{ revisions: Revision[] }>(event, `/admin/cms/blocks/${key}/revisions`);
		if (!history.ok) return failure(key, history);
		const revision = history.data.revisions.find((candidate) => candidate.version === version);
		if (!revision) return fail(404, { target: key, ok: false, message: 'Esa versión ya no está en el historial' });
		const saved = await saveDraft(event, key, revision.content);
		if (!saved.ok) return failure(key, saved);
		return { target: key, ok: true, message: `La versión ${version} quedó como borrador. Revisala y publicala` };
	},

	upload: async (event) => {
		const form = await event.request.formData();
		const file = form.get('image');
		if (!(file instanceof File) || file.size === 0) return fail(400, { target: 'media', ok: false, message: 'Elegí una imagen' });
		if (file.size > MEDIA_MAX_BYTES) return fail(400, { target: 'media', ok: false, message: 'La imagen supera 2 MB. Exportala más liviana (por ejemplo, JPEG de 1600 px de ancho)' });
		const result = await adminApi<CmsMedia>(event, `/admin/cms/media?filename=${encodeURIComponent(file.name.slice(0, 200))}`, {
			method: 'POST',
			raw: { bytes: await file.arrayBuffer(), contentType: 'application/octet-stream' }
		});
		if (!result.ok) return failure('media', result);
		const label = result.data.kind === 'video' ? 'Video subido' : 'Imagen subida';
		return { target: 'media', ok: true, message: result.status === 201 ? `${label}: ${result.data.filename}` : 'Ese archivo ya estaba en la biblioteca' };
	},

	/** The only route allowed a large body (see #lib/body-limit); `handle` has the API verify the session and cms.manage before anything reads it. */
	uploadVideo: async (event) => {
		if (!(await adminToken(event.cookies))) redirect(303, `/admin/login?next=${encodeURIComponent(event.url.pathname)}`);
		const form = await event.request.formData();
		const file = form.get('video');
		if (!(file instanceof File) || file.size === 0) return fail(400, { target: 'media', ok: false, message: 'Elegí un video' });
		if (file.size > VIDEO_MAX_BYTES) return fail(400, { target: 'media', ok: false, message: 'El video supera 50 MB. Acortalo o subilo a YouTube y usá el enlace' });
		const result = await adminApi<CmsMedia>(event, `/admin/cms/media?filename=${encodeURIComponent(file.name.slice(0, 200))}`, {
			method: 'POST',
			raw: { bytes: await file.arrayBuffer(), contentType: 'application/octet-stream' },
			timeoutMs: 120_000
		});
		if (!result.ok) return failure('media', result);
		if (result.data.kind !== 'video') return { target: 'media', ok: true, message: `Era una imagen: quedó en la biblioteca como ${result.data.filename}` };
		return { target: 'media', ok: true, message: result.status === 201 ? `Video subido: ${result.data.filename}` : 'Ese video ya estaba en la biblioteca' };
	},

	deleteMedia: async (event) => {
		const form = await event.request.formData();
		const result = await adminApi(event, `/admin/cms/media/${encodeURIComponent(text(form, 'id'))}`, { method: 'DELETE' });
		if (!result.ok) return failure('media', result);
		return { target: 'media', ok: true, message: text(form, 'kind') === 'video' ? 'Video borrado' : 'Imagen borrada' };
	},

	addFaq: async (event) => {
		const form = await event.request.formData();
		const result = await adminApi(event, '/admin/faqs', {
			method: 'POST',
			body: { question: text(form, 'question'), answer: text(form, 'answer'), position: Number(text(form, 'position') || '0') }
		});
		if (!result.ok) return failure('faq-new', result);
		invalidateSite(event.url.hostname);
		return { target: 'faq-new', ok: true, message: 'Pregunta agregada al sitio' };
	},

	updateFaq: async (event) => {
		const form = await event.request.formData();
		const id = text(form, 'id');
		const result = await adminApi(event, `/admin/faqs/${encodeURIComponent(id)}`, {
			method: 'PATCH',
			body: { question: text(form, 'question'), answer: text(form, 'answer'), position: Number(text(form, 'position') || '0') }
		});
		if (!result.ok) return failure(`faq-${id}`, result);
		invalidateSite(event.url.hostname);
		return { target: `faq-${id}`, ok: true, message: 'Pregunta guardada' };
	},

	deleteFaq: async (event) => {
		const form = await event.request.formData();
		const result = await adminApi(event, `/admin/faqs/${encodeURIComponent(text(form, 'id'))}`, { method: 'DELETE' });
		if (!result.ok) return failure('faq-new', result);
		invalidateSite(event.url.hostname);
		return { target: 'faq-new', ok: true, message: 'Pregunta borrada' };
	}
};
