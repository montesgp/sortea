import { z } from 'zod';
import { awardStatusLabel, roleLabel, WINNER_IDENTITY_WITHHELD } from './awards';

/**
 * The live coupon lookup screen (S7): what the API answered for one coupon,
 * turned into what the stream shows. The API already decided whether the
 * holder may be named; this file only words it.
 */

/** GET /admin/campaigns/:id/coupon-lookup */
export interface CouponLookup {
	campaign: { id: string; title: string; entryDigits: number; round: number; status: string };
	coupon: { entryNumber: number; label: string };
	outcome: 'not_sold' | 'void' | 'eligible';
	/** The current round's published manifest and the coupon's status in it; null while it is not published. */
	manifest: { round: number; status: 'eligible' | 'void' | null } | null;
	awards: { prize: string; position: number; slot: number; round: number; role: 'winner' | 'alternate'; rank: number; status: string }[];
	identity: { visibility: 'shown'; name: string; city: string | null; chances: number } | { visibility: 'withheld' } | { visibility: 'not_applicable' };
}

/** GET /admin/campaigns/:id/coupon-lookup/context */
export interface LookupContext {
	id: string;
	title: string;
	status: string;
	entryDigits: number;
	round: number;
}

export const lookupKinds = ['winner', 'alternate', 'plays', 'sold', 'void', 'not_sold'] as const;
export type LookupKind = (typeof lookupKinds)[number];

export interface LookupView {
	kind: LookupKind;
	tone: 'win' | 'ok' | 'neutral' | 'bad';
	/** "N.º 0042" */
	coupon: string;
	headline: string;
	prize: string | null;
	identity: { name: string; place: string | null; chances: string } | null;
	note: string | null;
}

export interface HistoryItem {
	coupon: string;
	kind: LookupKind;
	summary: string;
}

function kindOf(result: CouponLookup): LookupKind {
	const [award] = result.awards;
	if (award) return award.role;
	if (result.outcome === 'not_sold') return 'not_sold';
	// The manifest decides what plays: a purchase refunded after the close still appears in it.
	if (result.manifest?.status === 'eligible') return 'plays';
	if (result.outcome === 'void') return 'void';
	return 'sold';
}

const tones: Record<LookupKind, LookupView['tone']> = { winner: 'win', alternate: 'win', plays: 'ok', sold: 'ok', void: 'bad', not_sold: 'neutral' };

function prizeLabel(award: CouponLookup['awards'][number]): string {
	return award.round > 1 ? `${award.prize}, ronda ${award.round}` : award.prize;
}

export function lookupView(result: CouponLookup): LookupView {
	const kind = kindOf(result);
	const [award] = result.awards;
	const identity =
		result.identity.visibility === 'shown'
			? {
					name: result.identity.name,
					place: result.identity.city ? `de ${result.identity.city}` : null,
					chances: result.identity.chances === 1 ? '1 chance obtenida' : `${result.identity.chances} chances obtenidas`
				}
			: null;
	const headlines: Record<LookupKind, string> = {
		winner: 'Cupón ganador',
		alternate: award ? roleLabel('alternate', award.rank) : 'Suplente',
		plays: 'Cupón vendido y habilitado: participa del sorteo',
		sold: 'Cupón vendido y habilitado',
		void: 'Cupón anulado',
		not_sold: 'Cupón no vendido'
	};
	const notes: Partial<Record<LookupKind, string>> = {
		plays: 'El titular se muestra solo si el cupón resulta adjudicado al cargar el sorteo',
		sold: 'Entra al sorteo cuando se publique el manifiesto',
		void: 'No participa del sorteo: su compra se anuló o se reembolsó',
		not_sold: 'Nadie compró este número en esta campaña'
	};
	let note = notes[kind] ?? null;
	if (result.identity.visibility === 'withheld') note = WINNER_IDENTITY_WITHHELD;
	else if (award && !['pending_verification', 'accepted'].includes(award.status)) note = awardStatusLabel[award.status] ?? null;
	return { kind, tone: tones[kind], coupon: `N.º ${result.coupon.label}`, headline: headlines[kind], prize: award ? prizeLabel(award) : null, identity, note };
}

/** One line of the session list: the coupon and its outcome, never who holds it. */
export function historyItem(result: CouponLookup): HistoryItem {
	const kind = kindOf(result);
	const [award] = result.awards;
	const summaries: Record<LookupKind, string> = {
		winner: `Ganador · ${award ? prizeLabel(award) : ''}`,
		alternate: award ? `${roleLabel('alternate', award.rank)} · ${prizeLabel(award)}` : 'Suplente',
		plays: 'Participa del sorteo',
		sold: 'Vendido',
		void: 'Anulado',
		not_sold: 'No vendido'
	};
	return { coupon: result.coupon.label, kind, summary: summaries[kind] };
}

/** The session list is capped so a long night never grows the plain form without bound. */
export const HISTORY_LIMIT = 100;

const historySchema = z.array(z.object({ coupon: z.string().regex(/^\d{1,6}$/), kind: z.enum(lookupKinds), summary: z.string().max(200) }));

/** The list a plain form (without JavaScript) posts back in a hidden field. */
export function parseHistory(raw: string): HistoryItem[] {
	if (!raw) return [];
	try {
		const parsed = historySchema.safeParse(JSON.parse(raw));
		return parsed.success ? parsed.data.slice(-HISTORY_LIMIT) : [];
	} catch {
		return [];
	}
}

/** Whether the typed value is a whole coupon, so the screen searches without waiting for Enter. */
export function autoSubmitReady(value: string, entryDigits: number): boolean {
	const digits = value.replace(/\s+/g, '');
	return digits.length === entryDigits && /^\d+$/.test(digits);
}
