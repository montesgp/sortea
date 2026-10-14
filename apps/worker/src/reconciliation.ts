/**
 * The worker is the clock for reconciliation; the API does the work because it
 * is the only process that opens the organizations' provider credentials
 * (ADR 0004, ADR 0006). The API decides which organizations are due.
 */
export interface ReconciliationTriggerOptions {
	readonly apiUrl: string;
	readonly internalToken: string;
	readonly intervalMinutes: number;
	readonly fetchImpl?: typeof fetch;
}

export function createReconciliationTrigger(options: ReconciliationTriggerOptions): () => Promise<string> {
	const fetchImpl = options.fetchImpl ?? fetch;
	const url = new URL('/internal/reconciliation/run-due', options.apiUrl);
	return async () => {
		const response = await fetchImpl(url, {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'x-internal-token': options.internalToken },
			body: JSON.stringify({ intervalMinutes: options.intervalMinutes }),
			signal: AbortSignal.timeout(10 * 60_000)
		});
		if (!response.ok) throw new Error(`run-due answered HTTP ${response.status}`);
		const { results } = (await response.json()) as { results: { status: string; discrepancies?: number }[] };
		const counts = new Map<string, number>();
		for (const result of results) counts.set(result.status, (counts.get(result.status) ?? 0) + 1);
		const found = results.reduce((sum, result) => sum + (result.discrepancies ?? 0), 0);
		const parts = [...counts].map(([status, value]) => `${status}=${value}`);
		return `${parts.join(' ') || 'no organizations'}${found ? `, ${found} differences` : ''}`;
	};
}
