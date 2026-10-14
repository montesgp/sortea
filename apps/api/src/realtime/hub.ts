import { OPS_EVENTS_CHANNEL, type DatabaseHandle } from '@sortea/db';
import { parseOpsEvent, type OpsEvent } from '@sortea/domain';

export type HubMessage = OpsEvent | 'resync';
type Subscriber = (message: HubMessage) => void;

/** Open streams per organization; protects the API from a runaway tab or script. */
export const MAX_STREAMS_PER_ORGANIZATION = 50;

export interface OpsHub {
	start(): Promise<void>;
	stop(): Promise<void>;
	/** Returns null when the organization already has too many open streams. */
	subscribe(organizationId: string, subscriber: Subscriber): (() => void) | null;
}

/**
 * One LISTEN connection per API process fans committed change notices out to
 * the open dashboard streams of each organization (ADR 0007). Notifications
 * sent while the connection was down are lost, so every reconnect tells all
 * subscribers to resync from the snapshot.
 */
export function createOpsHub(db: DatabaseHandle): OpsHub {
	const subscribers = new Map<string, Set<Subscriber>>();
	let unlisten: (() => Promise<void>) | null = null;
	let connectedBefore = false;

	const deliver = (organizationId: string, message: HubMessage) => {
		for (const subscriber of subscribers.get(organizationId) ?? []) subscriber(message);
	};

	return {
		async start() {
			if (unlisten) return;
			const listener = await db.listen(
				OPS_EVENTS_CHANNEL,
				(payload) => {
					const event = parseOpsEvent(payload);
					if (event) deliver(event.organizationId, event);
				},
				() => {
					if (connectedBefore) for (const organizationId of subscribers.keys()) deliver(organizationId, 'resync');
					connectedBefore = true;
				}
			);
			unlisten = listener.unlisten;
		},

		async stop() {
			const current = unlisten;
			unlisten = null;
			subscribers.clear();
			await current?.();
		},

		subscribe(organizationId, subscriber) {
			const set = subscribers.get(organizationId) ?? new Set<Subscriber>();
			if (set.size >= MAX_STREAMS_PER_ORGANIZATION) return null;
			set.add(subscriber);
			subscribers.set(organizationId, set);
			return () => {
				set.delete(subscriber);
				if (set.size === 0) subscribers.delete(organizationId);
			};
		}
	};
}
