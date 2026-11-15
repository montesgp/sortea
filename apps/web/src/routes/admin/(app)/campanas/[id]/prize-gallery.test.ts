import type { Component } from 'svelte';
import { render } from 'svelte/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import CampaignAdminPage from './+page.svelte';

// owner-feedback-2026-11-14 S7: the prize editor adds, removes and reorders a prize's photos and videos.
const adminApi = vi.fn();
vi.mock('#lib/server/admin.js', () => ({ adminApi: (...args: unknown[]) => adminApi(...args), adminLoad: vi.fn() }));

const { actions } = await import('./+page.server');

const text = (html: string) =>
	html
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/<[^>]+>/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();

const video = 'media:0f0e0d0c-0b0a-4908-8706-050403020100/' + 'b'.repeat(64) + '.mp4';
const image = 'media:0f0e0d0c-0b0a-4908-8706-050403020100/' + 'a'.repeat(64) + '.jpg';
const gallery = [
	{ kind: 'image', url: '/tenants/demo/moto-taller.jpg', alt: 'La moto en el taller' },
	{ kind: 'video', url: video, alt: 'Video de la moto' },
	{ kind: 'image', url: '/tenants/demo/moto-lateral.jpg', alt: 'La moto de costado' }
];
const prize = {
	id: 'p1',
	position: 1,
	kind: 'vehicle',
	title: 'Moto',
	description: null,
	declaredValueMinor: 100,
	quantity: 1,
	alternatesCount: 0,
	mechanism: 'app',
	conditions: null,
	imageUrl: null,
	imagePreviewUrl: null,
	video: null,
	gallery,
	galleryPreview: gallery.map((item) => ({ ...item, url: item.url.replace('media:', 'https://media.test/') }))
};
const editor = { prizes: [prize], editable: false, videoEditable: true, imageEditable: true, galleryEditable: true, videos: [{ ref: video, filename: 'moto.mp4', url: 'https://media.test/v.mp4' }], images: [{ ref: image, filename: 'tanque.jpg', url: 'https://media.test/a.jpg' }] };

function event(form: FormData) {
	return {
		params: { id: 'c1' },
		url: new URL('https://demo.localhost/admin/campanas/c1?/prizeGallery'),
		request: new Request('https://demo.localhost/admin/campanas/c1?/prizeGallery', { method: 'POST', body: form })
	} as never;
}

const formOf = (fields: Record<string, string | File>) => {
	const form = new FormData();
	for (const [key, value] of Object.entries(fields)) form.set(key, value);
	return form;
};

/** The API answers the editor read and accepts the PATCH (or a library upload). */
function api() {
	adminApi.mockImplementation(async (_event: unknown, path: string, init?: { method?: string }) => {
		if (path === '/admin/campaigns/c1/prizes') return { ok: true, status: 200, data: editor };
		if (path.startsWith('/admin/cms/media')) return { ok: true, status: 201, data: { ref: image, kind: 'image' } };
		if (path === '/admin/prizes/p1' && init?.method === 'PATCH') return { ok: true, status: 200, data: {} };
		return { ok: false, status: 404, message: `unexpected ${path}` };
	});
}

const patched = () => adminApi.mock.calls.filter(([, path, init]) => path === '/admin/prizes/p1' && init?.method === 'PATCH').map(([, , init]) => init.body);

beforeEach(() => {
	adminApi.mockReset();
	api();
});

describe('prize gallery editor', () => {
	const campaign = {
		id: 'c1',
		productIds: [],
		products: [],
		slug: 'moto',
		title: 'Moto',
		subtitle: null,
		summary: 'S',
		status: 'open',
		isDemo: false,
		timezone: 'America/Argentina/Buenos_Aires',
		opensAt: '2026-10-20T00:00:00Z',
		closesAt: '2026-12-26T00:00:00Z',
		drawAt: null,
		streamUrl: null,
		replayUrl: null,
		video: null,
		requiredApprovals: [],
		gate: { allowed: true, missing: [], rejected: [] },
		allowedTransitions: [],
		canClose: false,
		approvals: [],
		rules: [],
		chanceVariants: [],
		prizes: [],
		events: [],
		manifest: null,
		totals: { eligibleEntries: 0, participants: 0 }
	};
	const page = (prizeEditor: unknown) =>
		render(CampaignAdminPage as Component, { props: { data: { campaign, prizeEditor, session: { organization: { currency: 'ARS' }, permissions: ['campaigns.manage'] } }, form: null } as never }).body;

	it('lists the gallery in order with move and remove buttons, and adds from the library, an address or an upload', () => {
		const body = page(editor);
		expect(text(body)).toContain('Galería de fotos y videos (3)');
		expect(text(body)).toMatch(/1\. Foto: La moto en el taller .*2\. Video: Video de la moto .*3\. Foto: La moto de costado/);
		expect(body).toMatch(/<button[^>]*name="op" value="up"[^>]*disabled[^>]*>Subir<\/button>/);
		expect(body).toMatch(/<button[^>]*name="op" value="down"[^>]*aria-label="Bajar: Video de la moto"/);
		expect(body).toContain('aria-label="Quitar: La moto de costado"');
		expect(body).toMatch(/<form[^>]*action="\?\/prizeGallery"[^>]*enctype="multipart\/form-data"/);
		expect(body).toMatch(/<option value="media:[^"]+\.mp4"[^>]*>moto\.mp4<\/option>/);
		expect(body).toMatch(/<option value="media:[^"]+\.jpg"[^>]*>tanque\.jpg<\/option>/);
		expect(body).toContain('name="galleryUrl"');
		expect(body).toContain('name="galleryFile"');
		expect(body).toMatch(/name="alt"[^>]*required/);
	});

	it('is not offered when the gallery cannot change, nor by an API without the field', () => {
		expect(text(page({ ...editor, galleryEditable: false }))).not.toContain('Galería de fotos y videos');
		const { galleryEditable: _editable, ...legacy } = editor;
		expect(text(page({ ...legacy, prizes: [{ ...prize, gallery: undefined, galleryPreview: undefined }] }))).not.toContain('Galería de fotos y videos');
	});

	it('adds a library video, an address and an uploaded photo at the end, each as its kind', async () => {
		expect(await actions.prizeGallery!(event(formOf({ prizeId: 'p1', op: 'add', alt: 'La moto en marcha', galleryMedia: video })))).toMatchObject({ ok: true, message: 'Agregado a la galería' });
		await actions.prizeGallery!(event(formOf({ prizeId: 'p1', op: 'add', alt: 'Otro video', galleryUrl: '/tenants/demo/moto.webm' })));
		await actions.prizeGallery!(event(formOf({ prizeId: 'p1', op: 'add', alt: 'Foto nueva', galleryFile: new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], 'nueva.jpg') })));
		const [first, second, third] = patched();
		expect(first).toEqual({ gallery: [...gallery, { kind: 'video', url: video, alt: 'La moto en marcha' }] });
		expect(second).toEqual({ gallery: [...gallery, { kind: 'video', url: '/tenants/demo/moto.webm', alt: 'Otro video' }] });
		expect(third).toEqual({ gallery: [...gallery, { kind: 'image', url: image, alt: 'Foto nueva' }] });
	});

	it('moves an item up or down and removes one, saving the whole list', async () => {
		await actions.prizeGallery!(event(formOf({ prizeId: 'p1', op: 'up', index: '1' })));
		await actions.prizeGallery!(event(formOf({ prizeId: 'p1', op: 'down', index: '1' })));
		expect(await actions.prizeGallery!(event(formOf({ prizeId: 'p1', op: 'remove', index: '0' })))).toMatchObject({ ok: true, message: 'Quitado de la galería' });
		expect(patched()).toEqual([
			{ gallery: [gallery[1], gallery[0], gallery[2]] },
			{ gallery: [gallery[0], gallery[2], gallery[1]] },
			{ gallery: [gallery[1], gallery[2]] }
		]);
	});

	it('refuses an item without a description or without a photo or video, before uploading or saving anything', async () => {
		const noAlt = await actions.prizeGallery!(event(formOf({ prizeId: 'p1', op: 'add', alt: ' ', galleryFile: new File([new Uint8Array([0xff, 0xd8, 0xff])], 'x.jpg') })));
		expect(noAlt).toMatchObject({ status: 400, data: { action: 'gallery-p1', ok: false, message: 'Describí la foto o el video en al menos 3 caracteres' } });
		const nothing = await actions.prizeGallery!(event(formOf({ prizeId: 'p1', op: 'add', alt: 'Algo' })));
		expect(nothing).toMatchObject({ status: 400, data: { message: 'Elegí una foto o un video de la biblioteca, escribí una dirección o subí una foto' } });
		expect(adminApi.mock.calls.filter(([, path]) => path !== '/admin/campaigns/c1/prizes')).toEqual([]);
	});
});
