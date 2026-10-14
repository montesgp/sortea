/**
 * Live operations feed (FR-OPS-02, AC-04). Events only say that something
 * changed; they never carry amounts, names or contact data. The dashboard
 * reacts by re-reading its snapshot, so an event lost in transit costs a
 * delay, never a wrong number.
 */
export const opsEventKinds = ['order.updated', 'campaign.updated', 'reconciliation.updated'] as const;
export type OpsEventKind = (typeof opsEventKinds)[number];

export interface OpsEvent {
	readonly organizationId: string;
	/** Per-organization sequence, assigned in commit order. */
	readonly sequence: number;
	readonly kind: OpsEventKind;
	readonly subjectId: string | null;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Parses a database notification payload; anything unexpected is dropped. */
export function parseOpsEvent(payload: string): OpsEvent | null {
	let value: unknown;
	try {
		value = JSON.parse(payload);
	} catch {
		return null;
	}
	if (!value || typeof value !== 'object') return null;
	const { organizationId, sequence, kind, subjectId } = value as Record<string, unknown>;
	if (typeof organizationId !== 'string' || !uuidPattern.test(organizationId)) return null;
	if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence < 1) return null;
	if (!opsEventKinds.includes(kind as OpsEventKind)) return null;
	if (subjectId !== null && (typeof subjectId !== 'string' || !uuidPattern.test(subjectId))) return null;
	return { organizationId, sequence, kind: kind as OpsEventKind, subjectId: subjectId as string | null };
}
