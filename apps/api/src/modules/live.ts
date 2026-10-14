import { and, asc, eq, gt, lte, schema as s, type Tx } from '@sortea/db';
import type { OpsEvent } from '@sortea/domain';
import type { FastifyInstance } from 'fastify';
import { requireAdmin } from '../lib/admin-context';
import { ApiError } from '../lib/errors';
import type { HubMessage, OpsHub } from '../realtime/hub';

/** Missed events replayed on reconnect; a longer gap is cheaper as a fresh snapshot. */
export const MAX_REPLAY = 200;
const HEARTBEAT_MS = 25_000;
/**
 * Streams end after a while and the browser reconnects with its last event
 * id: nothing is lost, and the admin's token and role are checked again, so a
 * revoked member stops receiving events within this window.
 */
export const STREAM_LIFETIME_MS = 10 * 60_000;

export async function currentSequence(tx: Tx): Promise<number> {
	const [row] = await tx.select({ value: s.opsSequences.lastSequence }).from(s.opsSequences);
	return row?.value ?? 0;
}

function parseAfter(value: unknown): number | null {
	const text = Array.isArray(value) ? value[0] : value;
	if (typeof text !== 'string' || !/^\d{1,15}$/.test(text)) return null;
	return Number(text);
}

/**
 * Server-sent events for the operations dashboard (FR-OPS-02, AC-04). The
 * stream resumes after `Last-Event-ID` (or `?after=`, the sequence of the
 * snapshot the page rendered); when it cannot prove that nothing was missed,
 * it sends `resync` and the page re-reads the snapshot.
 */
export async function liveRoutes(app: FastifyInstance, hub: OpsHub, options: { lifetimeMs?: number; heartbeatMs?: number } = {}) {
	const { deps } = app;

	app.get('/admin/events', async (request, reply) => {
		const admin = await requireAdmin(request, 'dashboard.view');
		const organizationId = admin.tenant.id;
		const after = parseAfter(request.headers['last-event-id']) ?? parseAfter((request.query as Record<string, unknown>).after);

		const queue: HubMessage[] = [];
		let replaying = true;
		let lastSent = 0;
		let open = true;
		const raw = reply.raw;

		const write = (chunk: string) => {
			if (open) raw.write(chunk);
		};
		const sendEvent = (event: OpsEvent) => {
			if (event.sequence <= lastSent) return;
			lastSent = event.sequence;
			write(`id: ${event.sequence}\nevent: ops\ndata: ${JSON.stringify({ kind: event.kind, subjectId: event.subjectId })}\n\n`);
		};
		const sendResync = (sequence: number) => {
			lastSent = Math.max(lastSent, sequence);
			write(`id: ${lastSent}\nevent: resync\ndata: {}\n\n`);
		};

		const unsubscribe = hub.subscribe(organizationId, (message) => {
			if (replaying) queue.push(message);
			else if (message === 'resync') void resyncNow();
			else sendEvent(message);
		});
		if (!unsubscribe) throw new ApiError(429, 'too_many_streams', 'Hay demasiados paneles abiertos para esta organización');

		const resyncNow = async () => {
			const sequence = await deps.db.withTenant(organizationId, currentSequence).catch(() => lastSent);
			sendResync(sequence);
		};

		reply.hijack();
		raw.writeHead(200, {
			'content-type': 'text/event-stream; charset=utf-8',
			'cache-control': 'no-store',
			connection: 'keep-alive',
			'x-accel-buffering': 'no'
		});
		write('retry: 5000\n\n');

		const heartbeat = setInterval(() => write(': ping\n\n'), options.heartbeatMs ?? HEARTBEAT_MS);
		const lifetime = setTimeout(() => close(), options.lifetimeMs ?? STREAM_LIFETIME_MS);
		const close = () => {
			if (!open) return;
			open = false;
			clearInterval(heartbeat);
			clearTimeout(lifetime);
			unsubscribe();
			raw.end();
		};
		request.raw.on('close', close);

		try {
			const { current, missed } = await deps.db.withTenant(organizationId, async (tx) => {
				const current = await currentSequence(tx);
				if (after === null || after >= current) return { current, missed: [] as OpsEvent[] };
				const rows = await tx
					.select()
					.from(s.opsEvents)
					.where(and(gt(s.opsEvents.sequence, after), lte(s.opsEvents.sequence, current)))
					.orderBy(asc(s.opsEvents.sequence))
					.limit(MAX_REPLAY + 1);
				return { current, missed: rows.map((row) => ({ organizationId, sequence: row.sequence, kind: row.kind, subjectId: row.subjectId })) };
			});

			if (after === null) {
				lastSent = current;
			} else if (after > current || current - after > MAX_REPLAY || missed.length !== current - after) {
				// Ahead of the server (database reset), too far behind, or events already pruned.
				sendResync(current);
			} else {
				lastSent = after;
				for (const event of missed) sendEvent(event);
			}
			replaying = false;
			for (const message of queue.splice(0)) {
				if (message === 'resync') await resyncNow();
				else sendEvent(message);
			}
		} catch (error) {
			request.log.error({ err: error }, 'live stream failed');
			close();
		}
	});
}
