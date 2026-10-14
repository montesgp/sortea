import { schema as s, type Executor } from '@sortea/db';

export type OutboxTopic = 'order.paid' | 'order.revoked' | 'lookup.otp';

/**
 * Written in the same transaction as the state change it announces, so an
 * email is sent if and only if the change committed. The dedupe key makes a
 * second enqueue for the same fact a no-op.
 */
export async function enqueue(
	executor: Executor,
	organizationId: string,
	topic: OutboxTopic,
	dedupeKey: string,
	payload: Record<string, unknown>
): Promise<void> {
	await executor
		.insert(s.outboxEvents)
		.values({ organizationId, topic, dedupeKey, payload })
		.onConflictDoNothing({ target: s.outboxEvents.dedupeKey });
}
