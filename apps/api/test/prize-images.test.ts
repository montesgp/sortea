import { randomBytes, randomUUID } from 'node:crypto';
import { eq, schema as s } from '@sortea/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminHeaders, createTenant, createTestContext, headers, type TenantFixture, type TestContext } from './helpers';

/** Prize thumbnails from the site library (owner feedback 2026-10-22, S2): picked or uploaded in the panel, resolved on the public pages. */

let ctx: TestContext;
let tenant: TenantFixture;
let other: TenantFixture;
const adminId = randomUUID();

const jpeg = (filler = randomBytes(16)) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), filler]);
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

async function prizeRows() {
	return ctx.db.withTenant(tenant.id, (tx) => tx.select().from(s.prizes).where(eq(s.prizes.campaignId, tenant.campaignId)));
}

async function prizeId(position: number) {
	return (await prizeRows()).find((row) => row.position === position)!.id;
}

async function setStatus(status: 'published' | 'open') {
	await ctx.db.withPlatform((db) => db.update(s.campaigns).set({ status }).where(eq(s.campaigns.id, tenant.campaignId)));
}

async function publicDetail() {
	return (await ctx.app.inject({ method: 'GET', url: `/public/campaigns/${tenant.campaignSlug}`, headers: headers(tenant) })).json();
}

async function publicList() {
	return (await ctx.app.inject({ method: 'GET', url: '/public/campaigns', headers: headers(tenant) })).json().campaigns[0];
}

beforeAll(async () => {
	ctx = await createTestContext();
	tenant = await createTenant(ctx, 'prize-images');
	other = await createTenant(ctx, 'prize-images-other');
	await ctx.db.withPlatform((db) => db.insert(s.organizationMembers).values({ organizationId: tenant.id, userId: adminId, email: `admin@${tenant.host}`, role: 'org_admin' }));
});
afterAll(() => ctx.close());

describe('prize images from the library', () => {
	let image: { id: string; ref: string };

	beforeAll(async () => {
		image = (await upload(jpeg(), 'moto.jpg')).json();
	});

	it('lists only library images for the prize picker, next to the videos', async () => {
		const video = (await upload(mp4(), 'moto.mp4')).json().ref as string;
		const editor = (await call('GET', `/admin/campaigns/${tenant.campaignId}/prizes`)).json();
		expect(editor.images).toContainEqual({ ref: image.ref, filename: 'moto.jpg', url: publicUrl(image.ref) });
		expect((editor.images as { ref: string }[]).map((item) => item.ref)).not.toContain(video);
		expect(editor.imageEditable).toBe(true);
	});

	it('saves an own library image on a prize and on a new one, and shows its thumbnail to the editors', async () => {
		const id = await prizeId(1);
		const saved = await call('PATCH', `/admin/prizes/${id}`, { imageUrl: image.ref });
		expect(saved.statusCode, saved.body).toBe(200);
		expect(saved.json().prizes.find((prize: { id: string }) => prize.id === id)).toMatchObject({ imageUrl: image.ref, imagePreviewUrl: publicUrl(image.ref) });

		const created = await call('POST', `/admin/campaigns/${tenant.campaignId}/prizes`, { kind: 'product', title: 'Casco', declaredValueMinor: 100, quantity: 1, alternatesCount: 0, imageUrl: image.ref });
		expect(created.statusCode, created.body).toBe(201);
		expect(created.json().prizes.find((prize: { title: string }) => prize.title === 'Casco').imageUrl).toBe(image.ref);

		// Paths and https URLs keep working and preview as they are.
		const path = await call('PATCH', `/admin/prizes/${await prizeId(2)}`, { imageUrl: '/tenants/demo/efectivo.jpg' });
		expect(path.json().prizes.find((prize: { position: number }) => prize.position === 2).imagePreviewUrl).toBe('/tenants/demo/efectivo.jpg');
	});

	it('refuses another organization’s image and a video where the image goes, without saving', async () => {
		const id = await prizeId(3);
		const foreign = (await upload(jpeg(), 'ajena.jpg', other, other.ownerId)).json().ref as string;
		const refused = await call('PATCH', `/admin/prizes/${id}`, { imageUrl: foreign });
		expect(refused.statusCode).toBe(400);
		expect(refused.json().error.code).toBe('unknown_media');
		const createdForeign = await call('POST', `/admin/campaigns/${tenant.campaignId}/prizes`, { kind: 'product', title: 'Guantes', declaredValueMinor: 100, quantity: 1, alternatesCount: 0, imageUrl: foreign });
		expect(createdForeign.json().error.code).toBe('unknown_media');

		const video = (await upload(mp4(), 'kit.mp4')).json().ref as string;
		expect((await call('PATCH', `/admin/prizes/${id}`, { imageUrl: video })).statusCode).toBe(400);

		const rows = await prizeRows();
		expect(rows.find((row) => row.id === id)!.imageUrl).toBeNull();
		expect(rows.some((row) => row.title === 'Guantes')).toBe(false);
	});

	it('resolves library images to public URLs on both public endpoints', async () => {
		const detail = (await publicDetail()).prizes as { title: string; imageUrl: string | null }[];
		expect(detail.find((prize) => prize.title === 'Moto')!.imageUrl).toBe(publicUrl(image.ref));
		expect(detail.find((prize) => prize.title === '$100.000')!.imageUrl).toBe('/tenants/demo/efectivo.jpg');
		expect(detail.find((prize) => prize.title === 'Kit')!.imageUrl).toBeNull();
		const listed = (await publicList()).prizes as { title: string; imageUrl: string | null }[];
		expect(listed.find((prize) => prize.title === 'Moto')!.imageUrl).toBe(publicUrl(image.ref));
		expect(JSON.stringify([await publicDetail(), await publicList()])).not.toContain('media:');
	});

	it('lets the image change after the campaign opens, audited, but nothing else with it', async () => {
		const id = await prizeId(3);
		await setStatus('open');
		try {
			const editor = (await call('GET', `/admin/campaigns/${tenant.campaignId}/prizes`)).json();
			expect(editor).toMatchObject({ editable: false, imageEditable: true });
			const changed = await call('PATCH', `/admin/prizes/${id}`, { imageUrl: image.ref });
			expect(changed.statusCode, changed.body).toBe(200);
			const mixed = await call('PATCH', `/admin/prizes/${id}`, { imageUrl: null, title: 'Otro' });
			expect(mixed.statusCode).toBe(409);
			expect(mixed.json().error.code).toBe('prizes_locked');
			const row = (await prizeRows()).find((prize) => prize.id === id)!;
			expect(row).toMatchObject({ title: 'Kit', imageUrl: image.ref });
			const audits = await ctx.db.withTenant(tenant.id, (tx) => tx.select({ metadata: s.auditEvents.metadata }).from(s.auditEvents).where(eq(s.auditEvents.action, 'prize.updated')));
			expect(audits.map((entry) => entry.metadata)).toContainEqual({ prizeId: id, fields: ['imageUrl'], imageUrl: { from: null, to: image.ref } });
		} finally {
			await setStatus('published');
		}
	});

	it('refuses to delete an image a prize uses, and marks it in use', async () => {
		let removal = await call('DELETE', `/admin/cms/media/${image.id}`);
		expect(removal.statusCode).toBe(409);
		expect(removal.json().error.code).toBe('media_in_use');
		const listed = (await call('GET', '/admin/cms')).json().media as { id: string; inUse: boolean }[];
		expect(listed.find((item) => item.id === image.id)?.inUse).toBe(true);
		expect(ctx.media.objects.has(image.ref.slice('media:'.length))).toBe(true);

		for (const row of await prizeRows()) {
			if (row.imageUrl === image.ref) await call('PATCH', `/admin/prizes/${row.id}`, { imageUrl: null });
		}
		removal = await call('DELETE', `/admin/cms/media/${image.id}`);
		expect(removal.statusCode, removal.body).toBe(200);
		expect(ctx.media.objects.has(image.ref.slice('media:'.length))).toBe(false);
	});
});
