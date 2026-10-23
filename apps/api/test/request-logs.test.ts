import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTenant, createTestContext, adminHeaders, type TenantFixture, type TestContext } from './helpers';

// Query strings carry what staff type to find a buyer (name, email; S4 of owner feedback
// 2026-10-22) and other request data; request logs keep the path only (SECURITY.md, logs without PII).
let ctx: TestContext;
let tenant: TenantFixture;
const lines: string[] = [];

beforeAll(async () => {
	ctx = await createTestContext({ logStream: { write: (line) => void lines.push(line) } });
	tenant = await createTenant(ctx, 'logs');
});
afterAll(() => ctx.close());

describe('request logs', () => {
	it('record the path of a search but never its query string', async () => {
		lines.length = 0;
		const response = await ctx.app.inject({ method: 'GET', url: '/admin/orders?q=ana.perez%40correo.test&status=paid', headers: await adminHeaders(ctx, tenant) });
		expect(response.statusCode).toBe(200);

		const requests = lines.map((line) => JSON.parse(line) as { req?: { method: string; url: string } }).filter((entry) => entry.req);
		expect(requests).toEqual([expect.objectContaining({ req: expect.objectContaining({ method: 'GET', url: '/admin/orders' }) })]);
		expect(lines.join('\n')).not.toMatch(/ana\.perez|correo\.test|q=/);
	});
});
