import { randomUUID } from 'node:crypto';
import { eq, schema as s, sql } from '@sortea/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_REPLAY } from '../src/modules/live';
import { adminHeaders, createTenant, createTestContext, openCampaign, placeOrder, webhookRequest, type TenantFixture, type TestContext } from './helpers';

const LIFETIME_MS = 4_000;

let ctx: TestContext;
let tenant: TenantFixture;
let other: TenantFixture;
let baseUrl: string;
const supportId = randomUUID();

beforeAll(async () => {
	ctx = await createTestContext({ live: { lifetimeMs: LIFETIME_MS, heartbeatMs: 1_000 } });
	tenant = await createTenant(ctx, 'live');
	other = await createTenant(ctx, 'live-other');
	await openCampaign(ctx, tenant);
	await ctx.db.withPlatform((db) => db.insert(s.organizationMembers).values({ organizationId: tenant.id, userId: supportId, email: `support@${tenant.host}`, role: 'support_agent' }));
	baseUrl = await ctx.app.listen({ port: 0, host: '127.0.0.1' });
});
afterAll(() => ctx.close());

interface StreamEvent {
	id: number | null;
	event: string;
	data: unknown;
}

/** Minimal EventSource for tests: records every event until closed or ended by the server. */
async function openStream(target: TenantFixture, options: { userId?: string; after?: number; lastEventId?: number } = {}) {
	const controller = new AbortController();
	const headers: Record<string, string> = await adminHeaders(ctx, target, options.userId ?? target.ownerId);
	if (options.lastEventId !== undefined) headers['last-event-id'] = String(options.lastEventId);
	const query = options.after === undefined ? '' : `?after=${options.after}`;
	const response = await fetch(`${baseUrl}/admin/events${query}`, { headers, signal: controller.signal });
	const events: StreamEvent[] = [];
	const comments: string[] = [];
	let ended = false;

	if (response.ok && response.body) {
		void (async () => {
			const decoder = new TextDecoder();
			let buffer = '';
			for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
				buffer += decoder.decode(chunk, { stream: true });
				let boundary: number;
				while ((boundary = buffer.indexOf('\n\n')) >= 0) {
					const block = buffer.slice(0, boundary);
					buffer = buffer.slice(boundary + 2);
					const fields: Record<string, string> = {};
					for (const line of block.split('\n')) {
						if (line.startsWith(':')) comments.push(line);
						const separator = line.indexOf(': ');
						if (separator > 0) fields[line.slice(0, separator)] = line.slice(separator + 2);
					}
					if (fields.event) events.push({ id: fields.id ? Number(fields.id) : null, event: fields.event, data: JSON.parse(fields.data ?? 'null') });
				}
			}
		})()
			.catch(() => {})
			.finally(() => {
				ended = true;
			});
	}

	return {
		status: response.status,
		contentType: response.headers.get('content-type'),
		events,
		comments,
		ended: () => ended,
		close: () => controller.abort(),
		async waitFor(predicate: (events: StreamEvent[]) => boolean, timeoutMs = 5_000) {
			const deadline = Date.now() + timeoutMs;
			while (!predicate(events)) {
				if (Date.now() > deadline) throw new Error(`timed out; received ${JSON.stringify(events)}`);
				await new Promise((resolve) => setTimeout(resolve, 25));
			}
		}
	};
}

async function snapshotSequence(target: TenantFixture): Promise<number> {
	const response = await ctx.app.inject({ method: 'GET', url: '/admin/overview', headers: await adminHeaders(ctx, target) });
	expect(response.statusCode).toBe(200);
	return response.json().lastEventId as number;
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('live dashboard stream (FR-OPS-02, AC-04)', () => {
	it('streams committed changes to the organization, in order, without personal data', async () => {
		const stream = await openStream(tenant, { after: await snapshotSequence(tenant) });
		expect(stream.status).toBe(200);
		expect(stream.contentType).toContain('text/event-stream');

		const order = await placeOrder(ctx, tenant);
		const payment = ctx.simulator.pay(order.preferenceId, 'approved');
		await ctx.app.inject(webhookRequest(tenant, payment.id));

		await stream.waitFor((events) => events.filter((event) => event.event === 'ops').length >= 2);
		const [created, paid] = stream.events;
		const [row] = await ctx.db.withTenant(tenant.id, (tx) => tx.select({ id: s.orders.id }).from(s.orders).where(eq(s.orders.reference, order.reference)));
		expect(created).toMatchObject({ event: 'ops', data: { kind: 'order.updated', subjectId: row!.id } });
		expect(paid!.id).toBe(created!.id! + 1);
		expect(JSON.stringify(stream.events)).not.toContain('juana');
		stream.close();
	});

	it('never streams another organization’s changes (AC-02)', async () => {
		const outsider = await openStream(other, { after: await snapshotSequence(other) });
		const own = await openStream(tenant, { after: await snapshotSequence(tenant) });

		await placeOrder(ctx, tenant);
		await own.waitFor((events) => events.length >= 1);
		await pause(300);
		expect(outsider.events).toEqual([]);

		const patched = await ctx.app.inject({
			method: 'PATCH',
			url: `/admin/campaigns/${other.campaignId}`,
			headers: await adminHeaders(ctx, other),
			payload: { subtitle: 'Cambio de la otra organización' }
		});
		expect(patched.statusCode).toBe(200);
		await outsider.waitFor((events) => events.some((event) => event.event === 'ops'));
		expect(outsider.events[0]!.data).toEqual({ kind: 'campaign.updated', subjectId: other.campaignId });
		await pause(300);
		expect(own.events.some((event) => (event.data as { subjectId?: string }).subjectId === other.campaignId)).toBe(false);
		outsider.close();
		own.close();
	});

	it('replays what a reconnecting dashboard missed, after its Last-Event-ID', async () => {
		const seen = await snapshotSequence(tenant);
		await placeOrder(ctx, tenant);
		await placeOrder(ctx, tenant);

		const stream = await openStream(tenant, { lastEventId: seen });
		await stream.waitFor((events) => events.length >= 2);
		expect(stream.events.map((event) => event.id)).toEqual([seen + 1, seen + 2]);
		stream.close();
	});

	it('asks for a resync when it cannot prove nothing was missed', async () => {
		const current = await snapshotSequence(tenant);

		// Ahead of the server (for example after a database reset).
		const ahead = await openStream(tenant, { lastEventId: current + 50 });
		await ahead.waitFor((events) => events.length >= 1);
		expect(ahead.events[0]).toMatchObject({ event: 'resync', id: current });
		ahead.close();

		// Too far behind to replay.
		const behind = await openStream(tenant, { lastEventId: Math.max(0, current - MAX_REPLAY - 1) });
		if (current > MAX_REPLAY) {
			await behind.waitFor((events) => events.length >= 1);
			expect(behind.events[0]!.event).toBe('resync');
		}
		behind.close();

		// A missed event was already pruned.
		const seen = await snapshotSequence(tenant);
		await placeOrder(ctx, tenant);
		await placeOrder(ctx, tenant);
		await ctx.db.withPlatform((db) => db.delete(s.opsEvents).where(sql`${s.opsEvents.organizationId} = ${tenant.id} and ${s.opsEvents.sequence} = ${seen + 1}`));
		const pruned = await openStream(tenant, { lastEventId: seen });
		await pruned.waitFor((events) => events.length >= 1);
		expect(pruned.events[0]).toMatchObject({ event: 'resync', id: seen + 2 });
		pruned.close();
	});

	it('tells every open dashboard to resync when the database listener reconnects', async () => {
		const stream = await openStream(tenant, { after: await snapshotSequence(tenant) });
		await pause(200);
		// Drop the API's LISTEN connection; the driver reconnects and the hub announces the gap.
		await ctx.db.withPlatform((db) =>
			db.execute(sql`select pg_terminate_backend(pid) from pg_stat_activity where datname = current_database() and query ilike 'listen%sortea_ops_events%'`)
		);
		await stream.waitFor((events) => events.some((event) => event.event === 'resync'), 10_000);

		// And keeps streaming afterwards.
		await placeOrder(ctx, tenant);
		await stream.waitFor((events) => events.some((event) => event.event === 'ops'), 10_000);
		stream.close();
	});

	it('requires a signed-in member who can see the dashboard', async () => {
		const anonymous = await fetch(`${baseUrl}/admin/events`, { headers: { 'x-internal-token': (await adminHeaders(ctx, tenant))['x-internal-token']!, 'x-tenant-host': tenant.host } });
		expect(anonymous.status).toBe(401);
		const support = await openStream(tenant, { userId: supportId });
		expect(support.status).toBe(403);
		const direct = await fetch(`${baseUrl}/admin/events`);
		expect(direct.status).toBe(401);
	});

	it('keeps the connection alive and ends it after its lifetime so access is checked again', async () => {
		const stream = await openStream(tenant, { after: await snapshotSequence(tenant) });
		await pause(1_500);
		expect(stream.comments.some((comment) => comment.startsWith(': ping'))).toBe(true);
		const deadline = Date.now() + LIFETIME_MS + 3_000;
		while (!stream.ended() && Date.now() < deadline) await pause(100);
		expect(stream.ended()).toBe(true);
	});
});
