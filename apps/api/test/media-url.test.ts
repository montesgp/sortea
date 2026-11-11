import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTenant, createTestContext, headers, INTERNAL_TOKEN, type TenantFixture, type TestContext } from './helpers';

// The site addresses library files as /media/<path>; the web asks this route for the presigned
// URL it redirects to (ADR 0020, "Files"). Paths are content hashes under the organization's id.

let ctx: TestContext;
let tenant: TenantFixture;
let other: TenantFixture;
const hash = 'b'.repeat(64);

async function presign(path: string, target: TenantFixture = tenant, extra: Record<string, string> = {}) {
	return ctx.app.inject({ method: 'GET', url: `/public/media/${path}`, headers: { ...headers(target), ...extra } });
}

beforeAll(async () => {
	ctx = await createTestContext();
	tenant = await createTenant(ctx, 'media-url');
	other = await createTenant(ctx, 'media-url-other');
});
afterAll(() => ctx.close());

describe('presigned media URL', () => {
	it('signs an image or a video of the tenant for the current window', async () => {
		for (const extension of ['jpg', 'png', 'webp', 'mp4', 'webm']) {
			const path = `${tenant.id}/${hash}.${extension}`;
			const response = await presign(path);
			expect(response.statusCode, response.body).toBe(200);
			expect(response.json()).toEqual(await ctx.deps.media.signedUrl(path, ctx.clock.now));
		}
	});

	it('refuses another organization’s file: the host decides the tenant, not the path', async () => {
		const response = await presign(`${other.id}/${hash}.jpg`);
		expect(response.statusCode).toBe(404);
		expect(response.json().error.code).toBe('not_found');
		expect((await presign(`${other.id}/${hash}.jpg`, other)).statusCode).toBe(200);
	});

	it('refuses anything that is not a library path: traversal, other prefixes, other names', async () => {
		for (const path of [
			`${tenant.id}/../${other.id}/${hash}.jpg`,
			`..%2F${tenant.id}/${hash}.jpg`,
			`${tenant.id}/%2e%2e/${hash}.jpg`,
			`site-media/${tenant.id}/${hash}.jpg`,
			`product-assets/${tenant.id}/p/${hash.slice(0, 16)}.pdf`,
			`backups/${tenant.id}/${hash}.jpg`,
			`${tenant.id}/p/${hash.slice(0, 16)}.pdf`,
			`${tenant.id}/${hash}.svg`,
			`${tenant.id}/${hash}.JPG`,
			`${tenant.id}/${hash.slice(1)}.jpg`,
			`${tenant.id}/${hash}.jpg/`,
			`${tenant.id}`,
			''
		]) {
			const response = await presign(path);
			expect(response.statusCode, path).toBe(404);
		}
	});

	it('is internal like every other route: no token, no URL', async () => {
		const response = await ctx.app.inject({ method: 'GET', url: `/public/media/${tenant.id}/${hash}.jpg`, headers: { 'x-tenant-host': tenant.host } });
		expect(response.statusCode).toBe(401);
		expect((await presign(`${tenant.id}/${hash}.jpg`, tenant, { 'x-internal-token': `${INTERNAL_TOKEN}x` })).statusCode).toBe(401);
	});

	it('needs a known site', async () => {
		const response = await presign(`${tenant.id}/${hash}.jpg`, { ...tenant, host: 'unknown.test' });
		expect(response.statusCode).toBe(404);
		expect(response.json().error.code).toBe('unknown_tenant');
	});
});
