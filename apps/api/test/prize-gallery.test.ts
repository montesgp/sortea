import { randomBytes, randomUUID } from 'node:crypto';
import { eq, schema as s } from '@sortea/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminHeaders, createTenant, createTestContext, headers, type TenantFixture, type TestContext } from './helpers';

/** A prize's photos and videos, like a product page (owner-feedback-2026-11-14 S7): edited in the panel, shown in order on the campaign page. */

let ctx: TestContext;
let tenant: TenantFixture;
let other: TenantFixture;
const adminId = randomUUID();

const jpeg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(16)]);
const mp4 = () => Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom', 'latin1'), Buffer.from([0, 0, 2, 0]), Buffer.from('isommp41', 'latin1'), randomBytes(32)]);
const publicUrl = (ref: string) => `https://media.test/${ref.slice('media:'.length)}`;

async function call(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown, target = tenant, userId = adminId) {
	return ctx.app.inject({ method, url, headers: await adminHeaders(ctx, target, userId), payload: payload as Record<string, unknown> | undefined });
}

async function upload(bytes: Buffer, filename: string, target = tenant, userId: string = adminId) {
	return ctx.app.inject({
		method: 'POST',
		url: `/admin/cms/media?filename=${encodeURIComponent(filename)}`,
		headers: { ...(await adminHeaders(ctx, target, userId)), 'content-type': 'application/octet-stream' },
		payload: bytes
	});
}

async function prizeRows(target = tenant) {
	return ctx.db.withTenant(target.id, (tx) => tx.select().from(s.prizes).where(eq(s.prizes.campaignId, target.campaignId)));
}

async function prizeId(position: number) {
	return (await prizeRows()).find((row) => row.position === position)!.id;
}

async function setStatus(status: 'published' | 'open') {
	await ctx.db.withPlatform((db) => db.update(s.campaigns).set({ status }).where(eq(s.campaigns.id, tenant.campaignId)));
}

async function publicPrizes(target = tenant) {
	const response = await ctx.app.inject({ method: 'GET', url: `/public/campaigns/${target.campaignSlug}`, headers: headers(target) });
	expect(response.statusCode, response.body).toBe(200);
	return response.json().prizes as { position: number; title: string; gallery: { kind: string; url: string; alt: string }[] }[];
}

beforeAll(async () => {
	ctx = await createTestContext();
	tenant = await createTenant(ctx, 'prize-gallery');
	other = await createTenant(ctx, 'prize-gallery-other');
	await ctx.db.withPlatform((db) => db.insert(s.organizationMembers).values({ organizationId: tenant.id, userId: adminId, email: `admin@${tenant.host}`, role: 'org_admin' }));
});
afterAll(() => ctx.close());

describe('prize gallery', () => {
	let image: { id: string; ref: string };
	let video: { id: string; ref: string };
	let gallery: { kind: 'image' | 'video'; url: string; alt: string }[];

	beforeAll(async () => {
		image = (await upload(jpeg(), 'moto.jpg')).json();
		video = (await upload(mp4(), 'moto.mp4')).json();
		gallery = [
			{ kind: 'image', url: '/tenants/demo/premios/moto-taller.jpg', alt: 'La moto en el taller' },
			{ kind: 'video', url: video.ref, alt: 'Video de la moto' },
			{ kind: 'image', url: image.ref, alt: 'Detalle del tanque' },
			{ kind: 'video', url: '/tenants/demo/premios/moto.mp4', alt: 'La moto en marcha' }
		];
	});

	it('saves the gallery of a prize in order and shows it to the editors with browser URLs', async () => {
		const id = await prizeId(1);
		const saved = await call('PATCH', `/admin/prizes/${id}`, { gallery });
		expect(saved.statusCode, saved.body).toBe(200);
		const prize = saved.json().prizes.find((entry: { id: string }) => entry.id === id);
		expect(prize.gallery).toEqual(gallery);
		expect(prize.galleryPreview).toEqual(gallery.map((item) => ({ ...item, url: item.url.startsWith('media:') ? publicUrl(item.url) : item.url })));

		const editor = (await call('GET', `/admin/campaigns/${tenant.campaignId}/prizes`)).json();
		expect(editor.galleryEditable).toBe(true);
		expect(editor.prizes.find((entry: { id: string }) => entry.id === id).gallery).toEqual(gallery);
		// A new prize starts with the gallery it is given, or none.
		const created = await call('POST', `/admin/campaigns/${tenant.campaignId}/prizes`, { kind: 'product', title: 'Casco', declaredValueMinor: 100, quantity: 1, alternatesCount: 0, gallery: [gallery[0]] });
		expect(created.statusCode, created.body).toBe(201);
		const prizes = created.json().prizes as { title: string; gallery: unknown[] }[];
		expect(prizes.find((entry) => entry.title === 'Casco')!.gallery).toEqual([gallery[0]]);
		expect(prizes.find((entry) => entry.title === 'Kit')!.gallery).toEqual([]);
	});

	it('returns each prize’s gallery in order on the public campaign, with library files as public URLs, and only for its organization', async () => {
		const prizes = await publicPrizes();
		expect(prizes.find((prize) => prize.position === 1)!.gallery).toEqual([
			{ kind: 'image', url: '/tenants/demo/premios/moto-taller.jpg', alt: 'La moto en el taller' },
			{ kind: 'video', url: publicUrl(video.ref), alt: 'Video de la moto' },
			{ kind: 'image', url: publicUrl(image.ref), alt: 'Detalle del tanque' },
			{ kind: 'video', url: '/tenants/demo/premios/moto.mp4', alt: 'La moto en marcha' }
		]);
		expect(prizes.find((prize) => prize.title === 'Kit')!.gallery).toEqual([]);
		expect(JSON.stringify(prizes)).not.toContain('media:');
		// Another organization's campaign with the same slug shows none of it.
		const theirs = await publicPrizes(other);
		expect(theirs.length).toBeGreaterThan(0);
		for (const prize of theirs) expect(prize.gallery).toEqual([]);
	});

	it('refuses another organization’s file, an item without alt text and a YouTube link, without saving', async () => {
		const id = await prizeId(2);
		const foreign = (await upload(jpeg(), 'ajena.jpg', other, other.ownerId)).json().ref as string;
		const refusedForeign = await call('PATCH', `/admin/prizes/${id}`, { gallery: [{ kind: 'image', url: foreign, alt: 'Ajena' }] });
		expect(refusedForeign.statusCode).toBe(400);
		expect(refusedForeign.json().error.code).toBe('unknown_media');
		for (const item of [
			{ kind: 'image', url: '/a.jpg', alt: '' },
			{ kind: 'video', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', alt: 'YouTube' }
		]) {
			expect((await call('PATCH', `/admin/prizes/${id}`, { gallery: [item] })).statusCode).toBe(400);
		}
		expect((await prizeRows()).find((row) => row.id === id)!.gallery).toEqual([]);
		expect((await prizeRows(other)).every((row) => row.gallery.length === 0)).toBe(true);
	});

	it('lets the gallery change after the campaign opens, audited, but nothing else with it', async () => {
		const id = await prizeId(1);
		await setStatus('open');
		try {
			const editor = (await call('GET', `/admin/campaigns/${tenant.campaignId}/prizes`)).json();
			expect(editor).toMatchObject({ editable: false, galleryEditable: true });
			const reordered = [gallery[2]!, gallery[0]!];
			const changed = await call('PATCH', `/admin/prizes/${id}`, { gallery: reordered });
			expect(changed.statusCode, changed.body).toBe(200);
			const mixed = await call('PATCH', `/admin/prizes/${id}`, { gallery: [], title: 'Otra' });
			expect(mixed.statusCode).toBe(409);
			expect(mixed.json().error.code).toBe('prizes_locked');
			expect((await prizeRows()).find((row) => row.id === id)).toMatchObject({ title: 'Moto', gallery: reordered });
			const audits = await ctx.db.withTenant(tenant.id, (tx) => tx.select({ metadata: s.auditEvents.metadata }).from(s.auditEvents).where(eq(s.auditEvents.action, 'prize.updated')));
			expect(audits.map((entry) => entry.metadata)).toContainEqual({ prizeId: id, fields: ['gallery'] });
		} finally {
			await setStatus('published');
		}
	});

	it('refuses to delete a library file only a gallery uses, and marks it in use', async () => {
		const id = await prizeId(1);
		await call('PATCH', `/admin/prizes/${id}`, { gallery: [{ kind: 'video', url: video.ref, alt: 'Video de la moto' }] });
		for (const row of await prizeRows()) expect(row.video).not.toBe(video.ref);
		let removal = await call('DELETE', `/admin/cms/media/${video.id}`);
		expect(removal.statusCode).toBe(409);
		expect(removal.json().error.code).toBe('media_in_use');
		const listed = (await call('GET', '/admin/cms')).json().media as { id: string; inUse: boolean }[];
		expect(listed.find((item) => item.id === video.id)?.inUse).toBe(true);

		await call('PATCH', `/admin/prizes/${id}`, { gallery: [] });
		removal = await call('DELETE', `/admin/cms/media/${video.id}`);
		expect(removal.statusCode, removal.body).toBe(200);
		expect(ctx.media.objects.has(video.ref.slice('media:'.length))).toBe(false);
	});
});
