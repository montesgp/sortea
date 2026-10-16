import { randomBytes, randomUUID } from 'node:crypto';
import { and, eq, schema as s } from '@sortea/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminHeaders, createTenant, createTestContext, headers, type TenantFixture, type TestContext } from './helpers';

/** Videos of what is raffled (S9, ADR 0009): uploads up to 50 MB or YouTube links, on campaigns and prizes. */

let ctx: TestContext;
let tenant: TenantFixture;
let other: TenantFixture;
const adminId = randomUUID();

const ascii = (text: string) => Buffer.from(text, 'latin1');
/** A tiny ISO BMFF header (`ftyp` box) followed by filler; enough for the byte sniffing. */
const mp4 = (filler = randomBytes(32)) => Buffer.concat([Buffer.from([0, 0, 0, 0x18]), ascii('ftypisom'), Buffer.from([0, 0, 2, 0]), ascii('isommp41'), filler]);
const webm = (filler = randomBytes(32)) =>
	Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0x82, 0x84]), ascii('webm'), Buffer.from([0x42, 0x87, 0x81, 0x04]), filler]);
const jpeg = (filler = randomBytes(16)) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), filler]);
const youtube = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const embed = 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ';

async function call(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown, target = tenant, userId = adminId) {
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

async function prizeIds(target = tenant) {
	const rows = await ctx.db.withTenant(target.id, (tx) => tx.select({ id: s.prizes.id, position: s.prizes.position }).from(s.prizes).where(eq(s.prizes.campaignId, target.campaignId)));
	return Object.fromEntries(rows.map((row) => [row.position, row.id])) as Record<number, string>;
}

async function setStatus(status: 'published' | 'open' | 'archived', target = tenant) {
	await ctx.db.withPlatform((db) => db.update(s.campaigns).set({ status }).where(eq(s.campaigns.id, target.campaignId)));
}

async function publicCampaign(target = tenant) {
	return (await ctx.app.inject({ method: 'GET', url: `/public/campaigns/${target.campaignSlug}`, headers: headers(target) })).json();
}

async function publicList(target = tenant) {
	return (await ctx.app.inject({ method: 'GET', url: '/public/campaigns', headers: headers(target) })).json().campaigns[0];
}

async function auditActions(target = tenant) {
	const rows = await ctx.db.withTenant(target.id, (tx) => tx.select({ action: s.auditEvents.action }).from(s.auditEvents));
	return rows.map((row) => row.action);
}

beforeAll(async () => {
	ctx = await createTestContext();
	tenant = await createTenant(ctx, 'videos');
	other = await createTenant(ctx, 'videos-other');
	await ctx.db.withPlatform((db) => db.insert(s.organizationMembers).values({ organizationId: tenant.id, userId: adminId, email: `admin@${tenant.host}`, role: 'org_admin' }));
});
afterAll(() => ctx.close());

describe('video uploads', () => {
	it('stores MP4 and WebM by content in the public bucket and lists them as videos', async () => {
		const bytes = mp4();
		const created = await upload(bytes, 'moto.mp4');
		expect(created.statusCode, created.body).toBe(201);
		const media = created.json();
		expect(media).toMatchObject({ kind: 'video', filename: 'moto.mp4', contentType: 'video/mp4', sizeBytes: bytes.length, inUse: false });
		expect(media.ref).toMatch(new RegExp(`^media:${tenant.id}/[0-9a-f]{64}\\.mp4$`));
		expect(ctx.media.objects.get(media.ref.slice('media:'.length))).toMatchObject({ contentType: 'video/mp4' });

		const second = await upload(webm(), 'moto.webm');
		expect(second.statusCode, second.body).toBe(201);
		expect(second.json()).toMatchObject({ kind: 'video', contentType: 'video/webm' });
		expect(second.json().ref).toMatch(/\.webm$/);

		const listed = (await call('GET', '/admin/cms')).json().media as { ref: string; kind: string }[];
		expect(listed.find((item) => item.ref === media.ref)?.kind).toBe('video');
		expect((await auditActions()).filter((action) => action === 'cms.media_uploaded')).toHaveLength(2);
	});

	it('takes videos up to 50 MB and refuses bigger ones without storing anything', async () => {
		const objects = ctx.media.objects.size;
		const atLimit = await upload(mp4(Buffer.alloc(50 * 1024 * 1024 - mp4(Buffer.alloc(0)).length)), 'limite.mp4');
		expect(atLimit.statusCode, atLimit.body).toBe(201);
		expect(ctx.media.objects.size).toBe(objects + 1);

		const tooBig = await upload(mp4(Buffer.alloc(50 * 1024 * 1024)), 'grande.mp4');
		expect(tooBig.statusCode).toBe(413);
		expect(ctx.media.objects.size).toBe(objects + 1);
	});

	it('refuses fake videos, whatever their name says', async () => {
		const objects = ctx.media.objects.size;
		const heic = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), ascii('ftypheic'), Buffer.from([0, 0, 0, 0]), ascii('mif1heic')]);
		for (const [bytes, name] of [
			[ascii('<html><script>alert(1)</script></html>'), 'clip.mp4'],
			[heic, 'clip.mp4'],
			[Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x82, 0x88]), ascii('matroska')]), 'clip.webm']
		] as const) {
			const response = await upload(bytes, name);
			expect(response.statusCode, name).toBe(415);
			expect(response.json().error.code).toBe('unsupported_media');
		}
		expect(ctx.media.objects.size).toBe(objects);
	});

	it('keeps images at 2 MB', async () => {
		const objects = ctx.media.objects.size;
		const response = await upload(jpeg(randomBytes(2 * 1024 * 1024)), 'grande.jpg');
		expect(response.statusCode).toBe(413);
		expect(response.json().error.code).toBe('media_too_large');
		expect(ctx.media.objects.size).toBe(objects);
		expect((await upload(jpeg(), 'chica.jpg')).statusCode).toBe(201);
	});

	it('does not raise the body limit of any other route', async () => {
		const response = await call('PATCH', `/admin/campaigns/${tenant.campaignId}`, { summary: 'x'.repeat(300 * 1024) });
		expect(response.statusCode).toBe(413);
	});

	it('refuses a video where an image goes', async () => {
		const video = (await upload(mp4(), 'logo.mp4')).json().ref as string;
		const response = await call('PUT', '/admin/cms/blocks/brand', { content: { logo: video, logoAlt: 'Logo', tagline: 'Hola' } });
		expect(response.statusCode).toBe(400);
		expect(response.json().error.code).toBe('invalid_content');
	});
});

describe('campaign and prize videos', () => {
	let video: { id: string; ref: string; url: string };

	beforeAll(async () => {
		video = (await upload(mp4(), 'premio.mp4')).json();
	});

	it('saves an uploaded video on the campaign and shows it resolved on the public pages', async () => {
		const saved = await call('PATCH', `/admin/campaigns/${tenant.campaignId}`, { video: video.ref });
		expect(saved.statusCode, saved.body).toBe(200);
		expect(saved.json().video).toBe(video.ref);

		const resolved = { kind: 'upload', url: `https://media.test/${video.ref.slice('media:'.length)}`, contentType: 'video/mp4' };
		expect((await publicCampaign()).video).toEqual(resolved);
		expect((await publicList()).video).toEqual(resolved);
	});

	it('saves a YouTube link on the campaign and exposes only the privacy-enhanced embed', async () => {
		const saved = await call('PATCH', `/admin/campaigns/${tenant.campaignId}`, { video: youtube });
		expect(saved.statusCode, saved.body).toBe(200);
		expect((await publicCampaign()).video).toEqual({ kind: 'youtube', embedUrl: embed });
		expect((await publicList()).video).toEqual({ kind: 'youtube', embedUrl: embed });

		const cleared = await call('PATCH', `/admin/campaigns/${tenant.campaignId}`, { video: null });
		expect(cleared.json().video).toBeNull();
		expect((await publicCampaign()).video).toBeNull();
	});

	it('refuses other links, images and videos of another organization without saving', async () => {
		const image = (await upload(jpeg(), 'foto.jpg')).json().ref as string;
		const foreign = (await upload(mp4(), 'ajeno.mp4', other, other.ownerId)).json().ref as string;
		await call('PATCH', `/admin/campaigns/${tenant.campaignId}`, { video: youtube });
		for (const value of ['https://vimeo.com/123456', 'https://cdn.example.com/clip.mp4', image]) {
			const response = await call('PATCH', `/admin/campaigns/${tenant.campaignId}`, { video: value });
			expect(response.statusCode, value).toBe(400);
		}
		const foreignSave = await call('PATCH', `/admin/campaigns/${tenant.campaignId}`, { video: foreign });
		expect(foreignSave.statusCode).toBe(400);
		expect(foreignSave.json().error.code).toBe('unknown_media');
		const prizes = await prizeIds();
		const foreignPrize = await call('PATCH', `/admin/prizes/${prizes[1]}`, { video: foreign });
		expect(foreignPrize.json().error.code).toBe('unknown_media');
		expect((await publicCampaign()).video).toEqual({ kind: 'youtube', embedUrl: embed });
	});

	it('saves prize videos and shows them on both public endpoints', async () => {
		const prizes = await prizeIds();
		const first = await call('PATCH', `/admin/prizes/${prizes[1]}`, { video: video.ref });
		expect(first.statusCode, first.body).toBe(200);
		expect(first.json().prizes.find((prize: { id: string }) => prize.id === prizes[1]).video).toBe(video.ref);
		const created = await call('POST', `/admin/campaigns/${tenant.campaignId}/prizes`, {
			kind: 'product',
			title: 'Casco',
			declaredValueMinor: 100,
			quantity: 1,
			alternatesCount: 0,
			video: youtube
		});
		expect(created.statusCode, created.body).toBe(201);

		const upload = { kind: 'upload', url: `https://media.test/${video.ref.slice('media:'.length)}`, contentType: 'video/mp4' };
		const detail = (await publicCampaign()).prizes as { title: string; video: unknown }[];
		expect(detail.find((prize) => prize.title === 'Moto')!.video).toEqual(upload);
		expect(detail.find((prize) => prize.title === 'Casco')!.video).toEqual({ kind: 'youtube', embedUrl: embed });
		expect(detail.find((prize) => prize.title === 'Kit')!.video).toBeNull();
		const listed = (await publicList()).prizes as { title: string; video: unknown }[];
		expect(listed.find((prize) => prize.title === 'Moto')!.video).toEqual(upload);
	});

	it('lists the library videos for the campaign editors', async () => {
		const editor = (await call('GET', `/admin/campaigns/${tenant.campaignId}/prizes`)).json();
		const refs = (editor.videos as { ref: string; filename: string; url: string }[]).map((item) => item.ref);
		expect(refs).toContain(video.ref);
		expect(refs.every((ref) => /\.(mp4|webm)$/.test(ref))).toBe(true);
	});

	it('lets the prize video change after the campaign opens, but nothing else', async () => {
		const prizes = await prizeIds();
		await setStatus('open');
		try {
			const changed = await call('PATCH', `/admin/prizes/${prizes[2]}`, { video: youtube });
			expect(changed.statusCode, changed.body).toBe(200);
			const title = await call('PATCH', `/admin/prizes/${prizes[2]}`, { video: null, title: 'Otro' });
			expect(title.statusCode).toBe(409);
			expect(title.json().error.code).toBe('prizes_locked');
			const [row] = await ctx.db.withTenant(tenant.id, (tx) => tx.select().from(s.prizes).where(eq(s.prizes.id, prizes[2]!)));
			expect(row).toMatchObject({ title: '$100.000', video: youtube });
		} finally {
			await setStatus('published');
		}
	});

	it('refuses to delete a video a campaign or a prize uses', async () => {
		const prizes = await prizeIds();
		// The prize still uses it.
		await call('PATCH', `/admin/campaigns/${tenant.campaignId}`, { video: null });
		let removal = await call('DELETE', `/admin/cms/media/${video.id}`);
		expect(removal.statusCode).toBe(409);
		expect(removal.json().error.code).toBe('media_in_use');

		// Only the campaign uses it.
		await call('PATCH', `/admin/prizes/${prizes[1]}`, { video: null });
		await call('PATCH', `/admin/campaigns/${tenant.campaignId}`, { video: video.ref });
		removal = await call('DELETE', `/admin/cms/media/${video.id}`);
		expect(removal.statusCode).toBe(409);
		expect(ctx.media.objects.has(video.ref.slice('media:'.length))).toBe(true);
		const listed = (await call('GET', '/admin/cms')).json().media as { id: string; inUse: boolean }[];
		expect(listed.find((item) => item.id === video.id)?.inUse).toBe(true);

		await call('PATCH', `/admin/campaigns/${tenant.campaignId}`, { video: null });
		removal = await call('DELETE', `/admin/cms/media/${video.id}`);
		expect(removal.statusCode, removal.body).toBe(200);
		expect(ctx.media.objects.has(video.ref.slice('media:'.length))).toBe(false);
	});

	it('does not save a campaign video being deleted', async () => {
		const doomed = (await upload(mp4(), 'borrando.mp4')).json() as { id: string; ref: string };
		let save: ReturnType<typeof call> | undefined;
		// Holds the row as a delete does, then removes it while the save waits.
		await ctx.db.withTenant(tenant.id, async (tx) => {
			await tx.select().from(s.cmsMedia).where(eq(s.cmsMedia.id, doomed.id)).for('update');
			save = call('PATCH', `/admin/campaigns/${tenant.campaignId}`, { video: doomed.ref });
			await new Promise((resolve) => setTimeout(resolve, 300));
			await tx.delete(s.cmsMedia).where(eq(s.cmsMedia.id, doomed.id));
		});
		const response = await save!;
		expect(response.statusCode, response.body).toBe(400);
		expect(response.json().error.code).toBe('unknown_media');
		const [campaign] = await ctx.db.withTenant(tenant.id, (tx) => tx.select({ video: s.campaigns.video }).from(s.campaigns).where(eq(s.campaigns.id, tenant.campaignId)));
		expect(campaign!.video).toBeNull();
	});

	it('refuses to delete a video a prize being saved points to', async () => {
		const kept = (await upload(mp4(), 'guardando.mp4')).json() as { id: string; ref: string };
		const prizes = await prizeIds();
		let removal: ReturnType<typeof call> | undefined;
		// Holds the row as a save does, writes the prize, and commits while the delete waits.
		await ctx.db.withTenant(tenant.id, async (tx) => {
			await tx.select().from(s.cmsMedia).where(eq(s.cmsMedia.id, kept.id)).for('share');
			await tx.update(s.prizes).set({ video: kept.ref }).where(and(eq(s.prizes.id, prizes[3]!)));
			removal = call('DELETE', `/admin/cms/media/${kept.id}`);
			await new Promise((resolve) => setTimeout(resolve, 300));
		});
		const response = await removal!;
		expect(response.statusCode, response.body).toBe(409);
		expect(response.json().error.code).toBe('media_in_use');
	});

	it('keeps the public responses free of internal data', async () => {
		const body = JSON.stringify([await publicCampaign(), await publicList()]);
		expect(body).not.toContain('media:');
		expect(body).not.toContain(tenant.campaignId);
		expect(body).not.toMatch(/organizationId|storagePath|sha256|uploadedBy/);
	});
});
