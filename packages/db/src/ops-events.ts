import type { OpsEventKind } from '@sortea/domain';
import { sql } from 'drizzle-orm';
import type { Executor } from './client';
import { opsEvents, opsSequences } from './schema';

/** Postgres channel the ops_events trigger notifies on. */
export const OPS_EVENTS_CHANNEL = 'sortea_ops_events';

/**
 * Records a change notice in the caller's transaction. Call it last: the
 * organization's counter row stays locked until commit, which is what keeps
 * sequence order equal to commit order.
 */
export async function publishOpsEvent(executor: Executor, organizationId: string, kind: OpsEventKind, subjectId: string | null = null): Promise<number> {
	const [row] = await executor
		.insert(opsSequences)
		.values({ organizationId, lastSequence: 1 })
		.onConflictDoUpdate({ target: opsSequences.organizationId, set: { lastSequence: sql`${opsSequences.lastSequence} + 1` } })
		.returning({ sequence: opsSequences.lastSequence });
	const sequence = row!.sequence;
	await executor.insert(opsEvents).values({ organizationId, sequence, kind, subjectId });
	return sequence;
}
