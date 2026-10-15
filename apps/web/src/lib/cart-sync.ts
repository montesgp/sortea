/**
 * Sends cart quantity changes to the server one at a time. The cart lives in a
 * cookie that every response rewrites whole, so two requests in flight could
 * land in either order and the older one would win; sending them in series,
 * keeping only the newest quantity per line, makes the latest choice the one
 * the server keeps. Once nothing is left to send, `settle` reloads the page
 * data so every amount shown comes from the server again (FR-COM-02).
 */
export interface CartSyncOptions {
	send: (variantId: string, quantity: number) => Promise<boolean>;
	settle: () => Promise<void>;
	onError?: (variantId: string) => void;
}

export function createCartSync({ send, settle, onError }: CartSyncOptions) {
	const queue = new Map<string, number>();
	let inFlight: string | null = null;
	let running: Promise<void> | null = null;

	async function drain() {
		try {
			while (queue.size > 0) {
				while (queue.size > 0) {
					const [variantId, quantity] = queue.entries().next().value!;
					queue.delete(variantId);
					inFlight = variantId;
					const ok = await send(variantId, quantity).catch(() => false);
					inFlight = null;
					if (!ok) onError?.(variantId);
				}
				// A failed refresh must not stop later changes from being sent.
				await settle().catch(() => undefined);
			}
		} finally {
			running = null;
		}
	}

	return {
		set(variantId: string, quantity: number) {
			queue.set(variantId, quantity);
			running ??= Promise.resolve().then(drain);
		},
		/** True while a change for this line has not been confirmed yet. */
		pending(variantId: string) {
			return queue.has(variantId) || inFlight === variantId;
		},
		idle(): Promise<void> {
			return running ?? Promise.resolve();
		}
	};
}
