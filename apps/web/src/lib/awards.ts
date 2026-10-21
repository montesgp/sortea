/** Spanish copy for award operations (AC-06). */

export const slotStateLabel: Record<string, { label: string; tone: 'ok' | 'warn' | 'bad' | 'neutral' }> = {
	empty: { label: 'Sin resultado', tone: 'neutral' },
	verifying: { label: 'Verificando', tone: 'warn' },
	accepted: { label: 'Aceptado, falta entregar', tone: 'warn' },
	delivered: { label: 'Entregado', tone: 'ok' },
	exhausted: { label: 'Sin suplentes disponibles', tone: 'bad' }
};

export const awardStatusLabel: Record<string, string> = {
	pending_verification: 'Pendiente',
	accepted: 'Aceptó',
	declined: 'Rechazó o no reclamó',
	void: 'Anulado',
	substituted: 'Reemplazado'
};

export const fulfillmentLabel: Record<string, string> = {
	pending: 'Entrega pendiente',
	scheduled: 'Entrega coordinada',
	delivered: 'Entregado',
	failed: 'Entrega fallida'
};

export function roleLabel(role: 'winner' | 'alternate', rank: number): string {
	return role === 'winner' ? 'Ganador' : `Suplente ${rank}`;
}

/** Next delivery states an operator can pick, mirroring the API's rules. */
export function fulfillmentOptions(current: string | null): string[] {
	const next: Record<string, string[]> = {
		pending: ['scheduled', 'delivered', 'failed'],
		scheduled: ['delivered', 'failed', 'pending'],
		failed: ['scheduled', 'pending'],
		delivered: []
	};
	return current === null ? ['pending', 'scheduled', 'delivered'] : (next[current] ?? []);
}

/** Coupon numbers typed in a form; blank fields are skipped, anything else must be a whole number. */
export function parseEntryNumbers(values: readonly string[]): number[] | null {
	const numbers: number[] = [];
	for (const value of values) {
		// "#42", "0042" and "N.º 0042" all name coupon 42; coupons start at 0000 (ADR 0014 §1).
		const text = value.trim().replace(/^(#|N\.º\s*)/i, '');
		if (!text) continue;
		if (!/^\d{1,9}$/.test(text)) return null;
		numbers.push(Number(text));
	}
	return numbers;
}
