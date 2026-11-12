import { and, eq, schema as s } from '@sortea/db';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { adminHeaders, createTenant, createTestContext, headers, placeOrder, webhookRequest, type TenantFixture, type TestContext } from './helpers';

// Owner feedback 2026-11-11b, S2 (decision L2): a ZIP is hard to open on a phone, so a digital product
// carries several files, images included, and the buyer gets one download link per file.

let ctx: TestContext;
let tenant: TenantFixture;

const png = (text: string) => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Buffer.from(text)]);
const jpeg = (text: string) => Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Buffer.from(text)]);

interface Asset {
	id: string;
	filename: string;
	contentType: string;
	sizeBytes: number;
}

beforeAll(async () => {
	ctx = await createTestContext();
	tenant = await createTenant(ctx, 'files');
});
afterAll(() => ctx.close());

async function call(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown, auth?: Record<string, string>) {
	return ctx.app.inject({ method, url, headers: auth ?? (await adminHeaders(ctx, tenant)), payload: payload as Record<string, unknown> | undefined });
}

/** Sends the file's bytes as the web tier does: the raw body, its name in the query. */
async function upload(method: 'POST' | 'PUT', url: string, bytes: Buffer, filename: string, name?: string, auth?: Record<string, string>) {
	const query = new URLSearchParams({ filename, ...(name ? { name } : {}) });
	return ctx.app.inject({
		method,
		url: `${url}?${query}`,
		headers: { ...(auth ?? (await adminHeaders(ctx, tenant))), 'content-type': 'application/octet-stream' },
		payload: bytes
	});
}

/** A digital product on sale with one variant and no file yet. */
async function digitalProduct(slug: string) {
	const created = await call('POST', '/admin/products', { slug, name: `Calcomanía ${slug}`, description: 'Calcomanía para descargar.', kind: 'digital' });
	expect(created.statusCode, created.body).toBe(201);
	const productId = created.json().id as string;
	const variant = await call('POST', `/admin/products/${productId}/variants`, { sku: slug.toUpperCase(), name: 'Digital', priceMinor: 100_000, stock: null, maxPerOrder: 3 });
	expect((await call('POST', `/admin/products/${productId}/status`, { status: 'active' })).statusCode).toBe(200);
	return { productId, variantId: variant.json().variants[0].id as string };
}

async function assetsOf(productId: string): Promise<Asset[]> {
	const detail = await call('GET', `/admin/products/${productId}`);
	return detail.json().assets;
}

async function audits(productId: string, action: string) {
	return ctx.db.withTenant(tenant.id, (tx) =>
		tx.select().from(s.auditEvents).where(and(eq(s.auditEvents.targetId, productId), eq(s.auditEvents.action, action)))
	);
}

describe('back office: the files of a digital product', () => {
	it('adds files one at a time, in order, each with a safe download name that matches its content', async () => {
		const { productId } = await digitalProduct('borde');

		const first = await upload('POST', `/admin/products/${productId}/files`, png('con borde'), 'Calcomanía con borde.png');
		expect(first.statusCode, first.body).toBe(201);
		const second = await upload('POST', `/admin/products/${productId}/files`, jpeg('fondo'), 'IMG_0001.HEIC', 'Fondo celular');
		expect(second.statusCode, second.body).toBe(201);

		const assets = second.json().assets as Asset[];
		expect(assets.map(({ filename, contentType, sizeBytes }) => ({ filename, contentType, sizeBytes }))).toEqual([
			{ filename: 'Calcomania-con-borde.png', contentType: 'image/png', sizeBytes: png('con borde').byteLength },
			{ filename: 'Fondo-celular.jpg', contentType: 'image/jpeg', sizeBytes: jpeg('fondo').byteLength }
		]);
		const added = await audits(productId, 'product.file_added');
		expect(added.map((event) => ({ actorType: event.actorType, filename: event.metadata.filename }))).toEqual([
			{ actorType: 'admin', filename: 'Calcomania-con-borde.png' },
			{ actorType: 'admin', filename: 'Fondo-celular.jpg' }
		]);
		const stored = [...ctx.files.objects.keys()].filter((path) => path.startsWith(`${tenant.id}/${productId}/`));
		expect(stored).toHaveLength(2);
	});

	describe('refuses, writing nothing', () => {
		it('a file that is not a PDF, ZIP, PNG or JPEG, an empty one, a physical product and an unknown one', async () => {
			const { productId } = await digitalProduct('rechazos');
			const objectsBefore = ctx.files.objects.size;

			const svg = await upload('POST', `/admin/products/${productId}/files`, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'logo.svg');
			expect(svg.statusCode).toBe(415);
			expect(svg.json().error).toMatchObject({ code: 'unsupported_file', message: 'Subí un PDF, un ZIP o una imagen PNG o JPEG' });
			const empty = await upload('POST', `/admin/products/${productId}/files`, Buffer.alloc(0), 'vacio.png');
			expect(empty.statusCode).toBe(400);
			expect(empty.json().error).toMatchObject({ code: 'empty_file', message: 'Elegí un archivo' });

			const [sticker] = await ctx.db.withTenant(tenant.id, (tx) => tx.select().from(s.products).where(eq(s.products.slug, 'sticker')));
			const physical = await upload('POST', `/admin/products/${sticker!.id}/files`, png('x'), 'x.png');
			expect(physical.statusCode).toBe(409);
			expect(physical.json().error).toMatchObject({ code: 'physical_product', message: 'Los productos físicos no llevan archivos' });
			const unknown = await upload('POST', '/admin/products/00000000-0000-4000-8000-000000000000/files', png('x'), 'x.png');
			expect(unknown.statusCode).toBe(404);

			expect(await assetsOf(productId)).toEqual([]);
			expect(ctx.files.objects.size).toBe(objectsBefore);
		});

		it('the same file twice and an eleventh file', async () => {
			const { productId } = await digitalProduct('lleno');
			for (let index = 0; index < 10; index++) expect((await upload('POST', `/admin/products/${productId}/files`, png(`f${index}`), `f${index}.png`)).statusCode).toBe(201);

			const again = await upload('POST', `/admin/products/${productId}/files`, png('f2'), 'otra.png');
			expect(again.statusCode).toBe(409);
			expect(again.json().error).toMatchObject({ code: 'duplicate_file', message: 'Este producto ya tiene ese archivo: f2.png' });
			const full = await upload('POST', `/admin/products/${productId}/files`, png('f10'), 'f10.png');
			expect(full.statusCode).toBe(409);
			expect(full.json().error).toMatchObject({ code: 'too_many_files', message: 'Un producto entrega hasta 10 archivos: quitá uno antes de agregar otro' });
			expect(await assetsOf(productId)).toHaveLength(10);
		});

		it('anyone without catalog.manage', async () => {
			const { productId } = await digitalProduct('permiso');
			const operator = await adminHeaders(ctx, tenant, tenant.operatorId);
			expect((await upload('POST', `/admin/products/${productId}/files`, png('p'), 'p.png', undefined, operator)).statusCode).toBe(403);
			const anonymous = await ctx.app.inject({
				method: 'POST',
				url: `/admin/products/${productId}/files?filename=p.png`,
				headers: { ...headers(tenant), 'content-type': 'application/octet-stream' },
				payload: png('p')
			});
			expect(anonymous.statusCode).toBe(401);
			expect(await assetsOf(productId)).toEqual([]);
		});
	});

	it('replaces one file in place, keeping its row, and deletes the previous object once its signed URLs expired', async () => {
		const { productId } = await digitalProduct('reemplazo');
		await upload('POST', `/admin/products/${productId}/files`, png('viejo'), 'viejo.png');
		await upload('POST', `/admin/products/${productId}/files`, png('otro'), 'otro.png');
		const [old, other] = await assetsOf(productId);
		const oldPath = [...ctx.files.objects.keys()].find((path) => path.startsWith(`${tenant.id}/${productId}/`) && ctx.files.objects.get(path)!.bytes.equals(png('viejo')))!;

		const replaced = await upload('PUT', `/admin/products/${productId}/files/${old!.id}`, jpeg('nuevo'), 'nuevo.jpg');

		expect(replaced.statusCode, replaced.body).toBe(200);
		expect((replaced.json().assets as Asset[]).map(({ id, filename }) => ({ id, filename }))).toEqual([
			{ id: old!.id, filename: 'nuevo.jpg' },
			{ id: other!.id, filename: 'otro.png' }
		]);
		const [event] = await audits(productId, 'product.file_replaced');
		expect(event!.metadata).toMatchObject({ filename: 'nuevo.jpg', previous: { filename: 'viejo.png' } });
		await vi.waitFor(() => expect(ctx.files.removed).toContain(oldPath));
		expect(ctx.files.waits).toContain(65_000);
	});
});

describe('the buyer of a product with several files', () => {
	let productId: string;
	let lookupToken: string;
	let orderId: string;
	let downloads: { assetId: string; filename: string }[];

	it('gets each file listed in Consultar, in order, each with its own link', async () => {
		const product = await digitalProduct('pack');
		productId = product.productId;
		for (const [index, name] of ['TallerDemo-calcomania-con-borde.png', 'TallerDemo-calcomania.png', 'TallerDemo-fondo-celular.png'].entries()) {
			expect((await upload('POST', `/admin/products/${productId}/files`, png(`pack${index}`), name)).statusCode).toBe(201);
		}
		const order = await placeOrder(ctx, tenant, { lines: [{ variantId: product.variantId, quantity: 1 }], campaignSlug: undefined });
		await ctx.app.inject(webhookRequest(tenant, ctx.simulator.pay(order.checkoutId, 'approved').id));
		const session = await ctx.app.inject({ method: 'POST', url: '/lookup/receipt', headers: headers(tenant), payload: { reference: order.reference, accessCode: order.accessCode } });
		lookupToken = session.json().token;

		const me = (await ctx.app.inject({ method: 'GET', url: '/lookup/me', headers: headers(tenant, { 'x-lookup-token': lookupToken }) })).json();
		orderId = me.orders[0].id;
		downloads = me.orders[0].downloads;
		expect(downloads.map((download) => download.filename)).toEqual(['TallerDemo-calcomania-con-borde.png', 'TallerDemo-calcomania.png', 'TallerDemo-fondo-celular.png']);

		for (const download of downloads) {
			const grant = await ctx.app.inject({ method: 'POST', url: '/lookup/downloads', headers: headers(tenant, { 'x-lookup-token': lookupToken }), payload: { orderId, assetId: download.assetId } });
			expect(grant.statusCode, grant.body).toBe(200);
			const file = await ctx.app.inject({ method: 'GET', url: `/downloads/${grant.json().token}`, headers: headers(tenant) });
			expect(file.statusCode, file.body).toBe(200);
			expect(file.json()).toMatchObject({ filename: download.filename });
		}
	});

	it('loses only the link of a file the shop removes, and the removal is recorded', async () => {
		const removedFile = downloads[1]!;
		const grant = await ctx.app.inject({ method: 'POST', url: '/lookup/downloads', headers: headers(tenant, { 'x-lookup-token': lookupToken }), payload: { orderId, assetId: removedFile.assetId } });
		const token = grant.json().token as string;

		const removed = await call('DELETE', `/admin/products/${productId}/files/${removedFile.assetId}`);

		expect(removed.statusCode, removed.body).toBe(200);
		expect((removed.json().assets as Asset[]).map((asset) => asset.filename)).toEqual(['TallerDemo-calcomania-con-borde.png', 'TallerDemo-fondo-celular.png']);
		expect((await ctx.app.inject({ method: 'GET', url: `/downloads/${token}`, headers: headers(tenant) })).statusCode).toBe(410);
		const me = (await ctx.app.inject({ method: 'GET', url: '/lookup/me', headers: headers(tenant, { 'x-lookup-token': lookupToken }) })).json();
		expect(me.orders[0].downloads.map((download: { filename: string }) => download.filename)).toEqual(['TallerDemo-calcomania-con-borde.png', 'TallerDemo-fondo-celular.png']);
		const [event] = await audits(productId, 'product.file_removed');
		expect(event).toMatchObject({ actorType: 'admin', metadata: { filename: 'TallerDemo-calcomania.png', grants: 2 } });

		const again = await call('DELETE', `/admin/products/${productId}/files/${removedFile.assetId}`);
		expect(again.statusCode).toBe(404);
	});
});
