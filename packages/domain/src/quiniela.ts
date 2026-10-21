import { z } from 'zod';

/**
 * Prizes decided by an official Quiniela draw (ADR 0014 §2-§4). The admin
 * records the 20 extracts of the named draw; matching them against the
 * published manifest is deterministic and adds no randomness of its own.
 */

/** How a prize is decided: by the Quiniela extracts, or recorded by hand (today's flow). */
export const prizeMechanisms = ['quiniela', 'manual'] as const;
export type PrizeMechanism = (typeof prizeMechanisms)[number];

/** A Quiniela draw yields 20 extracts of 4 digits, so only a 0000–9999 pool can be drawn from it. */
export const quinielaExtractCount = 20;
export const quinielaEntryDigits = 4;

export const quinielaDrawInputSchema = z.object({
	source: z.string().trim().min(3, 'Indicá qué sorteo de la Quiniela es, por ejemplo "Quiniela de la Ciudad, Nocturna"').max(200),
	/** The official time of the draw; it has to be later than the manifest publication (ADR 0014 §3). */
	drawnAt: z.coerce.date('Indicá la fecha y la hora del sorteo'),
	extracts: z
		.array(z.number().int().min(0).max(9_999), 'Cargá los 20 extractos')
		.length(quinielaExtractCount, 'Cargá los 20 extractos en su orden oficial'),
	evidenceUrl: z.url({ protocol: /^https$/, message: 'La evidencia es un enlace https al extracto oficial' })
});
export type QuinielaDrawInput = z.infer<typeof quinielaDrawInputSchema>;

/** Confirming sends back the digest of the preview it saw (ADR 0014 §4). */
export const quinielaConfirmInputSchema = quinielaDrawInputSchema.extend({
	digest: z.string().regex(/^[0-9a-f]{64}$/, 'Volvé a ver las coincidencias antes de confirmar')
});

export interface QuinielaPrize {
	readonly id: string;
	readonly mechanism: PrizeMechanism;
	readonly position: number;
	readonly quantity: number;
	readonly alternatesCount: number;
	/** Breaks ties between prizes sharing a position, then the id does. */
	readonly createdAt?: Date;
	/** Slots that already have a winner; the draw leaves them alone. */
	readonly filledSlots?: readonly number[];
}

export interface QuinielaMatchInput {
	/** In their official order, 1st to 20th. */
	readonly extracts: readonly number[];
	readonly prizes: readonly QuinielaPrize[];
	/** The status a coupon had in the published manifest, or null when it is not there. */
	readonly manifestStatus: (entryNumber: number) => 'eligible' | 'void' | null;
	/** Coupons already holding an award in this campaign, in any role. */
	readonly awarded: ReadonlySet<number>;
}

/**
 * What each extract did: gave a winner or an alternate, matched with no slot
 * left (`spare`), matched nothing, repeated an earlier extract, or named a
 * coupon that had already won.
 */
export type ExtractOutcome = 'winner' | 'alternate' | 'spare' | 'no_match' | 'repeated' | 'already_awarded';

export interface ExtractResult {
	/** 1-based, the official order. */
	readonly position: number;
	readonly number: number;
	readonly outcome: ExtractOutcome;
	readonly prizeId: string | null;
	readonly slot: number | null;
	/** Alternate rank, 1-based; null for winners and unused extracts. */
	readonly rank: number | null;
}

export interface QuinielaSlotResult {
	readonly prizeId: string;
	readonly slot: number;
	readonly winner: { readonly entryNumber: number; readonly extract: number } | null;
	readonly alternates: readonly { readonly entryNumber: number; readonly extract: number; readonly rank: number }[];
}

export interface QuinielaMatch {
	readonly extracts: readonly ExtractResult[];
	/** Every open quiniela slot, in prize position then slot order. */
	readonly slots: readonly QuinielaSlotResult[];
	readonly vacant: readonly { readonly prizeId: string; readonly slot: number }[];
}

/**
 * Walks the extracts 1 → 20. An extract matches when its number is an eligible
 * coupon of the manifest that has not won yet. Matches fill the winners of the
 * quiniela slots in prize order (position, then slot); the matches left over
 * fill each slot's alternates, slot by slot, up to the prize's alternatesCount.
 * The extract number is the coupon number: the pool is 0000–9999.
 */
export function matchQuinielaDraw(input: QuinielaMatchInput): QuinielaMatch {
	const slots = [...input.prizes]
		.filter((prize) => prize.mechanism === 'quiniela')
		.sort(comparePrizes)
		.flatMap((prize) =>
			Array.from({ length: prize.quantity }, (_, index) => index + 1)
				.filter((slot) => !prize.filledSlots?.includes(slot))
				.map((slot) => ({ prize, slot, winner: null as { entryNumber: number; extract: number } | null, alternates: [] as { entryNumber: number; extract: number; rank: number }[] }))
		);

	const seen = new Set<number>();
	const extracts: ExtractResult[] = [];
	let matched = 0;
	for (const [index, number] of input.extracts.entries()) {
		const position = index + 1;
		const unused = (outcome: ExtractOutcome): ExtractResult => ({ position, number, outcome, prizeId: null, slot: null, rank: null });
		if (seen.has(number)) {
			extracts.push(unused('repeated'));
			continue;
		}
		seen.add(number);
		if (input.manifestStatus(number) !== 'eligible') {
			extracts.push(unused('no_match'));
			continue;
		}
		if (input.awarded.has(number)) {
			extracts.push(unused('already_awarded'));
			continue;
		}
		const target = assign(slots, matched++);
		if (!target) {
			extracts.push(unused('spare'));
			continue;
		}
		if (target.role === 'winner') {
			target.entry.winner = { entryNumber: number, extract: position };
			extracts.push({ position, number, outcome: 'winner', prizeId: target.entry.prize.id, slot: target.entry.slot, rank: null });
		} else {
			const rank = target.entry.alternates.length + 1;
			target.entry.alternates.push({ entryNumber: number, extract: position, rank });
			extracts.push({ position, number, outcome: 'alternate', prizeId: target.entry.prize.id, slot: target.entry.slot, rank });
		}
	}

	return {
		extracts,
		slots: slots.map(({ prize, slot, winner, alternates }) => ({ prizeId: prize.id, slot, winner, alternates })),
		vacant: slots.filter((entry) => entry.winner === null).map(({ prize, slot }) => ({ prizeId: prize.id, slot }))
	};
}

/**
 * Quiniela units with no winner (ADR 0014 §5), in the order of `prizes`.
 * `throughRound` counts only the winners recorded up to that round, so each
 * round's vacancies can be told apart. Meaningful once a draw was recorded:
 * before that, a quiniela unit is pending, not vacant.
 */
export function vacantQuinielaSlots<P extends Pick<QuinielaPrize, 'id' | 'mechanism' | 'quantity'>>(
	prizes: readonly P[],
	winners: readonly { readonly prizeId: string; readonly slot: number; readonly round: number }[],
	throughRound = Number.POSITIVE_INFINITY
): { prize: P; slot: number }[] {
	return prizes
		.filter((prize) => prize.mechanism === 'quiniela')
		.flatMap((prize) =>
			Array.from({ length: prize.quantity }, (_, index) => index + 1)
				.filter((slot) => !winners.some((winner) => winner.prizeId === prize.id && winner.slot === slot && winner.round <= throughRound))
				.map((slot) => ({ prize, slot }))
		);
}

/** Prize order: position, then creation, then id, so the same prizes always give the same order. */
export function comparePrizes(a: Pick<QuinielaPrize, 'id' | 'position' | 'createdAt'>, b: Pick<QuinielaPrize, 'id' | 'position' | 'createdAt'>): number {
	if (a.position !== b.position) return a.position - b.position;
	const created = (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0);
	if (created !== 0) return created;
	return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * The canonical text a preview digest is computed from: what will be recorded
 * and everything it awards. Confirming recomputes it and must get the same.
 */
export function quinielaDigestPayload(input: QuinielaDrawInput, match: QuinielaMatch): string {
	return JSON.stringify({
		source: input.source,
		drawnAt: input.drawnAt.toISOString(),
		extracts: input.extracts,
		evidenceUrl: input.evidenceUrl,
		outcomes: match.extracts.map((extract) => [extract.position, extract.number, extract.outcome, extract.prizeId, extract.slot, extract.rank]),
		slots: match.slots.map((slot) => [slot.prizeId, slot.slot, slot.winner?.entryNumber ?? null, slot.alternates.map((alternate) => alternate.entryNumber)])
	});
}

/** The n-th match (0-based) goes to the n-th winner seat, then to the alternate seats in slot order. */
function assign<T extends { prize: QuinielaPrize; winner: unknown }>(slots: T[], match: number): { role: 'winner' | 'alternate'; entry: T } | null {
	if (match < slots.length) return { role: 'winner', entry: slots[match]! };
	let seat = match - slots.length;
	// Only slots with a winner take alternates; a vacant slot has nobody to replace.
	for (const entry of slots) {
		if (entry.winner === null) continue;
		if (seat < entry.prize.alternatesCount) return { role: 'alternate', entry };
		seat -= entry.prize.alternatesCount;
	}
	return null;
}
