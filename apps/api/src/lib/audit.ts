import { schema as s, type Executor } from '@sortea/db';

export interface AuditInput {
	organizationId: string | null;
	actorType: 'admin' | 'platform_admin' | 'buyer' | 'system' | 'provider';
	actorId?: string | null;
	action: string;
	targetType: string;
	targetId?: string | null;
	/** Never put secrets, document numbers or full emails here. */
	metadata?: Record<string, unknown>;
}

export async function audit(executor: Executor, input: AuditInput): Promise<void> {
	await executor.insert(s.auditEvents).values({
		organizationId: input.organizationId,
		actorType: input.actorType,
		actorId: input.actorId ?? null,
		action: input.action,
		targetType: input.targetType,
		targetId: input.targetId ?? null,
		metadata: input.metadata ?? {}
	});
}
