import { z } from 'zod';
import type { AppDrawCandidate, AppDrawPick } from './app-draw';
import { extractOutcomeLabel, ordinal } from './quiniela';

/**
 * The draw room (odd/tasks/draw-room.md T5; S3, S4, L1): the screen the person
 * running the live draw works on, and its broadcast mode. The API decides
 * everything (the matches, the units that can be drawn, the pick, who may be
 * named); this module only turns its answers into the rows the screen shows,
 * keeps the draft of the extracts typed so far and words each state.
 */

// ─── API shapes ───────────────────────────────────────────────────────────

/** `GET /admin/draw-room/campaigns`, one row. */
export interface DrawRoomCampaignSummary {
	id: string;
	slug: string;
	title: string;
	subtitle: string | null;
	status: string;
	timezone: string;
	drawAt: string | null;
	round: number;
}

export interface DrawRoomPrize {
	id: string;
	position: number;
	title: string;
	quantity: number;
	/** `app`: drawn whole in the room with one drand-backed tirada (ADR 0026). */
	mechanism: 'quiniela' | 'manual' | 'app';
	imageUrl: string | null;
}

/** Who holds a unit now. `identity` only when the holder consented to be named (winner_publicity). */
export interface DrawRoomWinner {
	prizeId: string;
	prizeTitle: string;
	position: number;
	slot: number;
	round: number;
	role: 'winner' | 'alternate';
	source: 'app_draw' | 'quiniela' | 'manual';
	entryNumber: string;
	maskedName: string;
	identity: { name: string; city: string | null; chances: number } | null;
}

/** One in-app tirada of the round (ADR 0024 §4). */
export interface DrawRoomTirada {
	round: number;
	sequence: number;
	attempt: number;
	prizeId: string;
	prizeTitle: string;
	slot: number;
	drawnAt: string;
	candidateCount: number;
	candidateSha256: string;
	pick: AppDrawCandidate;
}

/** `POST /admin/campaigns/:id/app-draw/units` and its replay: the tirada with every candidate. */
export interface DrawRoomTiradaResult extends DrawRoomTirada {
	campaign: { id: string; title: string; round: number; entryDigits: number; timezone: string };
	candidates: AppDrawCandidate[];
}

/** `GET /admin/draw-room/campaigns/:id`. */
export interface DrawRoomView {
	campaign: {
		id: string;
		slug: string;
		title: string;
		subtitle: string | null;
		status: string;
		timezone: string;
		drawAt: string | null;
		entryDigits: number;
		awardOrder: 'first_to_last' | 'last_to_first';
		round: number;
	};
	prizes: DrawRoomPrize[];
	coupons: { eligible: number };
	manifest: { round: number; sha256: string; eligibleCount: number; publishedAt: string | null } | null;
	quinielaDraw: { round: number; source: string; drawnAt: string; extracts: number[]; evidenceUrl: string } | null;
	winners: DrawRoomWinner[];
	appDraw: {
		tiradas: DrawRoomTirada[];
		units: { prizeId: string; prizeTitle: string; slot: number; state: 'vacant' | 'exhausted' }[];
		candidateCount: number | null;
		reason: string | null;
	};
	/** The `app` prizes in award order (draw-room T8, ADR 0026 §6), without candidate lists. */
	appPrizes?: { prizes: AppPrizeView[]; candidateCount: number | null; reason: string | null };
}

/** One drand-backed tirada of an `app` prize (ADR 0026 §4): `beacon` and `picks` once its round is revealed. */
export interface AppPrizeTirada {
	prizeId: string;
	prizeTitle: string;
	round: number;
	sequence: number;
	attempt: number;
	state: 'committed' | 'drawn';
	units: number[];
	drandRound: number;
	drandRoundAt: string;
	committedAt: string;
	candidateCount: number;
	candidateSha256: string;
	beacon: { signature: string; randomness: string; url: string } | null;
	picks: { slot: number; entryNumber: string; maskedName: string }[] | null;
	revealedAt: string | null;
}

/** `POST /admin/campaigns/:id/app-draw/prizes/:prizeId`: the tirada with every candidate, for the reel. */
export interface AppPrizeDrawResult extends AppPrizeTirada {
	campaign: { id: string; title: string; round: number; entryDigits: number; timezone: string };
	candidates: AppDrawCandidate[];
}

/** One `app` prize of `appPrizes`: `committed` while its tirada waits for the drand round. */
export interface AppPrizeView {
	prizeId: string;
	prizeTitle: string;
	position: number;
	quantity: number;
	state: 'pending' | 'committed' | 'drawn';
	units: { slot: number; state: 'pending' | 'exhausted' | 'held' | 'void' }[];
	pendingUnits: number[];
	tiradas: AppPrizeTirada[];
	/** Why it cannot be drawn now, else null. */
	reason: string | null;
}

/** `POST /admin/campaigns/:id/quiniela/preview` with the extracts typed so far (1 to 20). */
export interface QuinielaLivePreview {
	extracts: { position: number; number: number; outcome: string; prizeId: string | null; slot: number | null; rank: number | null }[];
	slots: { prizeId: string; prizeTitle: string; slot: number; winner: { entryNumber: number; extract: number } | null; alternates: { entryNumber: number; extract: number; rank: number }[] }[];
	vacant: { prizeId: string; prizeTitle: string; slot: number }[];
	holders?: { entryNumber: number; maskedName: string }[];
	/** Only for a complete preview (20 extracts and the draw's data): what the record is checked against. */
	digest: string | null;
}

// ─── Who may use what ─────────────────────────────────────────────────────

export const DRAW_ROOM_PATH = '/admin/sala-de-sorteo';

/**
 * A session that only runs the draw (`draw_host`, permission `draws.run` and no
 * campaign management): the panel shows it the draw room and nothing else. The
 * API refuses every other route anyway (PRD §4); this decides the layout.
 */
export function drawRoomOnly(permissions: readonly string[]): boolean {
	return permissions.includes('draws.run') && !permissions.includes('campaigns.view');
}

/** The panel pages a draw-room-only session may open: the room, its own account, and `/admin`, which sends it to the room. */
export function drawRoomAllows(pathname: string): boolean {
	const path = pathname.replace(/\/+$/, '') || '/';
	return path === '/admin' || [DRAW_ROOM_PATH, '/admin/cuenta'].some((allowed) => path === allowed || path.startsWith(`${allowed}/`));
}

// ─── Header ───────────────────────────────────────────────────────────────

export const awardOrderLabel: Record<DrawRoomView['campaign']['awardOrder'], string> = {
	first_to_last: 'Se adjudica del primer premio al último',
	last_to_first: 'Se adjudica del último premio al primero'
};

export const unitsLabel = (quantity: number) => (quantity === 1 ? '1 unidad' : `${quantity} unidades`);

// ─── The 20 positions ─────────────────────────────────────────────────────

export const EXTRACT_COUNT = 20;
export const EXTRACT_DIGITS = 4;

export const emptyExtracts = (): string[] => Array.from({ length: EXTRACT_COUNT }, () => '');

/** What a position keeps of what was typed or pasted: digits only, at most 4. */
export function extractInput(value: string): string {
	return value.replace(/\D/g, '').slice(0, EXTRACT_DIGITS);
}

export const extractComplete = (value: string) => /^\d{4}$/.test(value);

/** The position to move to after typing `value` in `index`: the next one once 4 digits are in, else none. */
export function positionAfterInput(index: number, value: string): number | null {
	return extractComplete(value) && index < EXTRACT_COUNT - 1 ? index + 1 : null;
}

/** Where Enter, Backspace on an empty field or the arrow keys move from `index`; null to stay. */
export function positionAfterKey(index: number, key: string, value: string): number | null {
	if (key === 'Enter' || key === 'ArrowDown') return index < EXTRACT_COUNT - 1 ? index + 1 : null;
	if (key === 'ArrowUp' || (key === 'Backspace' && value === '')) return index > 0 ? index - 1 : null;
	return null;
}

/**
 * The extracts the server can match: the complete ones from the 1st on, until
 * the first position still empty or half typed. The matching follows the
 * official order, so a later number waits for the ones before it.
 */
export function typedPrefix(values: readonly string[]): number[] {
	const prefix: number[] = [];
	for (const value of values) {
		if (!extractComplete(value)) break;
		prefix.push(Number(value));
	}
	return prefix;
}

export interface ExtractRow {
	position: number;
	/** "1.º" */
	label: string;
	value: string;
	state: 'empty' | 'typing' | 'waiting' | 'checking' | 'won' | 'alternate' | 'other';
	/** What the number did, in words; null while there is nothing to say. */
	outcome: string | null;
}

/**
 * Each position as the screen shows it, with the outcome of the latest preview
 * when it covers that number. A position past the first gap "waits" for it.
 */
export function extractRows(values: readonly string[], preview: QuinielaLivePreview | null, prizeLabel: (prizeId: string, slot: number) => string): ExtractRow[] {
	const prefix = typedPrefix(values).length;
	return values.map((value, index) => {
		const position = index + 1;
		const base = { position, label: ordinal(position), value };
		if (!value) return { ...base, state: 'empty', outcome: null };
		if (!extractComplete(value)) return { ...base, state: 'typing', outcome: null };
		if (index >= prefix) return { ...base, state: 'waiting', outcome: 'Falta un número anterior' };
		const result = preview?.extracts[index];
		if (!result || result.number !== Number(value)) return { ...base, state: 'checking', outcome: 'Buscando…' };
		if (result.outcome === 'winner') return { ...base, state: 'won', outcome: `Ganador: ${prizeLabel(result.prizeId!, result.slot!)}` };
		if (result.outcome === 'alternate') return { ...base, state: 'alternate', outcome: `Suplente ${result.rank}: ${prizeLabel(result.prizeId!, result.slot!)}` };
		return { ...base, state: 'other', outcome: extractOutcomeLabel[result.outcome] ?? result.outcome };
	});
}

/**
 * The recorded extracts: each number, and the unit it gave when its coupon
 * holds that unit now by the Quiniela. Nothing is said of the others, which the
 * record does not keep (no match, repeated, or a coupon passed over later).
 */
export function recordedExtractRows(view: Pick<DrawRoomView, 'campaign' | 'prizes' | 'quinielaDraw' | 'winners'>): ExtractRow[] {
	const extracts = view.quinielaDraw?.extracts ?? [];
	return extracts.map((number, index) => {
		const value = String(number).padStart(EXTRACT_DIGITS, '0');
		const winner = view.winners.find((candidate) => candidate.source === 'quiniela' && candidate.entryNumber === String(number).padStart(view.campaign.entryDigits, '0'));
		const prize = winner && view.prizes.find((candidate) => candidate.id === winner.prizeId);
		const base = { position: index + 1, label: ordinal(index + 1), value };
		if (!winner || !prize) return { ...base, state: 'other', outcome: null };
		return { ...base, state: winner.role === 'winner' ? 'won' : 'alternate', outcome: `${winner.role === 'winner' ? 'Ganador' : 'Suplente'}: ${unitLabel(prize, winner.slot)}` };
	});
}

// ─── Draft (L1: "Se confirma al final") ───────────────────────────────────

export const DEFAULT_QUINIELA_SOURCE = 'Quiniela de la Ciudad, Nocturna';

/** What the person typed and has not recorded yet; kept in this browser in case the page is lost. */
export interface QuinielaDraft {
	extracts: string[];
	source: string;
	/** dd/mm/aaaa and hh:mm, as typed. */
	drawDate: string;
	drawTime: string;
	evidenceUrl: string;
}

export const emptyDraft = (): QuinielaDraft => ({ extracts: emptyExtracts(), source: DEFAULT_QUINIELA_SOURCE, drawDate: '', drawTime: '', evidenceUrl: '' });

/** One draft per campaign and round: a later round never restores an earlier round's numbers. */
export const draftKey = (campaignId: string, round: number) => `sortea:sala-de-sorteo:${campaignId}:ronda-${round}`;

const draftSchema = z.object({
	extracts: z.array(z.string().max(EXTRACT_DIGITS)).max(EXTRACT_COUNT),
	source: z.string().max(200),
	drawDate: z.string().max(10),
	drawTime: z.string().max(5),
	evidenceUrl: z.string().max(2000)
});

/** A stored draft, or a fresh one when there is none or it cannot be read. Positions keep digits only. */
export function parseDraft(raw: string | null): QuinielaDraft {
	if (!raw) return emptyDraft();
	try {
		const parsed = draftSchema.safeParse(JSON.parse(raw));
		if (!parsed.success) return emptyDraft();
		const extracts = emptyExtracts().map((_, index) => extractInput(parsed.data.extracts[index] ?? ''));
		return { ...parsed.data, extracts };
	} catch {
		return emptyDraft();
	}
}

/** Whether there is anything worth keeping: a number or a field changed from its default. */
export function draftHasContent(draft: QuinielaDraft): boolean {
	return draft.extracts.some(Boolean) || draft.drawDate !== '' || draft.drawTime !== '' || draft.evidenceUrl !== '' || draft.source !== DEFAULT_QUINIELA_SOURCE;
}

/** Saves the draft, or removes it once it is empty. */
export function storeDraft(storage: Pick<Storage, 'setItem' | 'removeItem'>, key: string, draft: QuinielaDraft) {
	if (draftHasContent(draft)) storage.setItem(key, JSON.stringify(draft));
	else storage.removeItem(key);
}

// ─── The winners table ────────────────────────────────────────────────────

export type UnitState = 'won' | 'live' | 'vacant' | 'exhausted' | 'pending' | 'manual' | 'closed';

export interface UnitRow {
	key: string;
	prizeId: string;
	prizeTitle: string;
	slot: number;
	/** "Moto" or "$100.000, unidad 2". */
	label: string;
	mechanism: 'quiniela' | 'manual' | 'app';
	state: UnitState;
	/** The holder: the coupon in full, and the consented name or the masked one. */
	holder: { entryNumber: string; name: string; note: string | null } | null;
	/** The API lists the unit as drawable in the app now. */
	drawable: boolean;
}

export const unitLabel = (prize: Pick<DrawRoomPrize, 'title' | 'quantity'>, slot: number) => (prize.quantity > 1 ? `${prize.title}, unidad ${slot}` : prize.title);

/** The name the screen may show: the public name when the holder consented (winner_publicity), else "Ju*** P.". */
export const holderName = (winner: Pick<DrawRoomWinner, 'maskedName' | 'identity'>) => winner.identity?.name ?? winner.maskedName;

const sourceNote: Record<DrawRoomWinner['source'], string> = { quiniela: 'Quiniela', app_draw: 'Sorteo en la app', manual: 'Cargado a mano' };

/**
 * Every unit in award order: the Quiniela prizes in the campaign's order (from
 * the last prize when it says so, ADR 0014 §4), then the prizes loaded by hand.
 * Before the round's Quiniela is recorded, `live` overlays the matches of the
 * extracts typed so far; after it, the API's winners and drawable units decide.
 */
export function unitRows(view: Pick<DrawRoomView, 'campaign' | 'prizes' | 'quinielaDraw' | 'winners' | 'appDraw'>, live: QuinielaLivePreview | null = null): UnitRow[] {
	const quiniela = view.prizes.filter((prize) => prize.mechanism === 'quiniela');
	if (view.campaign.awardOrder === 'last_to_first') quiniela.reverse();
	const ordered = [...quiniela, ...view.prizes.filter((prize) => prize.mechanism === 'manual')];
	const masked = new Map((live?.holders ?? []).map((holder) => [holder.entryNumber, holder.maskedName]));
	const pad = (entryNumber: number) => String(entryNumber).padStart(view.campaign.entryDigits, '0');
	return ordered.flatMap((prize) =>
		Array.from({ length: prize.quantity }, (_, index): UnitRow => {
			const slot = index + 1;
			const base = { key: `${prize.id}-${slot}`, prizeId: prize.id, prizeTitle: prize.title, slot, label: unitLabel(prize, slot), mechanism: prize.mechanism, drawable: false };
			const winner = view.winners.find((candidate) => candidate.prizeId === prize.id && candidate.slot === slot);
			if (winner) {
				const note = [sourceNote[winner.source], winner.role === 'alternate' ? 'suplente' : null].filter(Boolean).join(', ');
				return { ...base, state: 'won', holder: { entryNumber: winner.entryNumber, name: holderName(winner), note } };
			}
			if (prize.mechanism === 'manual') return { ...base, state: 'manual', holder: null };
			if (!view.quinielaDraw) {
				const matched = live?.slots.find((candidate) => candidate.prizeId === prize.id && candidate.slot === slot)?.winner;
				if (matched) return { ...base, state: 'live', holder: { entryNumber: pad(matched.entryNumber), name: masked.get(matched.entryNumber) ?? '', note: `Extracto ${ordinal(matched.extract)}` } };
				return { ...base, state: 'pending', holder: null };
			}
			const open = view.appDraw.units.find((unit) => unit.prizeId === prize.id && unit.slot === slot);
			if (open) return { ...base, state: open.state, holder: null, drawable: view.appDraw.reason === null };
			return { ...base, state: 'closed', holder: null };
		})
	);
}

export const unitStateLabel: Record<UnitState, string> = {
	won: 'Ganador',
	live: 'Ganador (sin confirmar)',
	vacant: 'Vacante',
	exhausted: 'Vacante: sin suplentes',
	pending: 'Por definir',
	manual: 'Se carga a mano',
	closed: 'Sin ganador'
};

/** "3 de 7": units with a holder, live matches included. */
export function tableProgress(rows: readonly UnitRow[]): string {
	return `${rows.filter((row) => row.holder).length} de ${rows.length}`;
}

// ─── In-app tiradas ───────────────────────────────────────────────────────

/** A tirada as the reel plays it: one winner, no alternates (ADR 0024 §3). */
export function tiradaPick(tirada: Pick<DrawRoomTirada, 'prizeId' | 'prizeTitle' | 'slot' | 'pick'>): AppDrawPick {
	return { prizeId: tirada.prizeId, prizeTitle: tirada.prizeTitle, slot: tirada.slot, role: 'winner', rank: 1, entryNumber: tirada.pick.entryNumber, maskedName: tirada.pick.maskedName };
}

export const candidatesLabel = (count: number) => (count === 1 ? '1 cupón' : `${new Intl.NumberFormat('es-AR').format(count)} cupones`);

// ─── App prizes: one drand-backed tirada per prize (T9; S6, S8) ──────────

/** The Quiniela entry stays only while the campaign still has Quiniela prizes (S6: set aside for now). */
export const showQuinielaEntry = (view: Pick<DrawRoomView, 'prizes'>) => view.prizes.some((prize) => prize.mechanism === 'quiniela');

export const appPrizeStateLabel: Record<AppPrizeView['state'], string> = {
	pending: 'Pendiente',
	committed: 'Comprometido: esperando el número de drand',
	drawn: 'Sorteado'
};

export interface AppPrizeRow {
	prizeId: string;
	title: string;
	imageUrl: string | null;
	quantity: number;
	unitsLabel: string;
	state: AppPrizeView['state'];
	stateLabel: string;
	/** Whoever holds each unit now: the coupon and the consented public name or the masked one. */
	winners: { slot: number; entryNumber: string; name: string }[];
	/** Units the next tirada draws. */
	pendingCount: number;
	/** The drand round its pending tirada waits for, else null. */
	drandRound: number | null;
	drawable: boolean;
	/** The next prize in award order: the one highlighted action. */
	primary: boolean;
	reason: string | null;
	drawLabel: string;
}

/**
 * The `app` prizes as the room lists them, in the API's award order. A prize the
 * API allows is drawable; the first drawable one not yet drawn is the primary
 * action (with a tirada pending, that one, the only one the API allows).
 */
export function appPrizeRows(view: Pick<DrawRoomView, 'prizes' | 'winners' | 'appPrizes'>): AppPrizeRow[] {
	const prizes = view.appPrizes?.prizes ?? [];
	const primary = prizes.find((prize) => prize.state !== 'drawn' && prize.reason === null)?.prizeId ?? null;
	return prizes.map((prize) => ({
		prizeId: prize.prizeId,
		title: prize.prizeTitle,
		imageUrl: view.prizes.find((candidate) => candidate.id === prize.prizeId)?.imageUrl ?? null,
		quantity: prize.quantity,
		unitsLabel: unitsLabel(prize.quantity),
		state: prize.state,
		stateLabel: appPrizeStateLabel[prize.state],
		winners: view.winners
			.filter((winner) => winner.prizeId === prize.prizeId)
			.sort((a, b) => a.slot - b.slot)
			.map((winner) => ({ slot: winner.slot, entryNumber: winner.entryNumber, name: holderName(winner) })),
		pendingCount: prize.pendingUnits.length,
		drandRound: prize.state === 'committed' ? (prize.tiradas.find((tirada) => tirada.state === 'committed')?.drandRound ?? null) : null,
		drawable: prize.state !== 'drawn' && prize.reason === null,
		primary: prize.prizeId === primary,
		reason: prize.reason,
		drawLabel: `Sortear ${prize.prizeTitle}`
	}));
}

/** "Se sortean 3 ganadores de «Efectivo» entre 12 cupones sin premio." */
export function drawConfirmText(row: Pick<AppPrizeRow, 'title' | 'pendingCount'>, candidateCount: number | null): string {
	const winners = row.pendingCount === 1 ? 'Se sortea 1 ganador' : `Se sortean ${row.pendingCount} ganadores`;
	return `${winners} de «${row.title}» entre ${candidateCount === null ? 'los cupones' : candidatesLabel(candidateCount)} sin premio.`;
}

/** How often the room asks again while the round is not out, and for how long before offering "Reintentar". */
export const DRAND_POLL_MS = 2_000;
export const DRAND_WAIT_MS = 60_000;

/**
 * What to do with an answer of the tirada `POST`, `elapsedMs` after the click:
 * reveal it (201, or 200 when another request revealed it), ask again in
 * `DRAND_POLL_MS` while the round is pending (202) or the answer was lost
 * (null, or the panel could not reach the API), give up waiting at the minute
 * ("Reintentar" resumes the same round), or stop on a refusal. Asking again
 * never starts a new tirada: the API resumes the committed one.
 */
export function drawStep(answer: { status: number; transient?: boolean } | null, elapsedMs: number): 'reveal' | 'retry' | 'stalled' | 'refused' {
	if (answer && (answer.status === 200 || answer.status === 201)) return 'reveal';
	const waiting = answer === null || answer.status === 202 || (answer.status === 503 && answer.transient === true);
	if (!waiting) return 'refused';
	return elapsedMs + DRAND_POLL_MS < DRAND_WAIT_MS ? 'retry' : 'stalled';
}

export const waitingText = (drandRound: number | null) => `Esperando el número público de drand${drandRound === null ? '' : ` (ronda ${drandRound})`}…`;

/** The picks of a revealed tirada as the reel stops on them, one per unit in drawing order. */
export function prizeDrawPicks(tirada: Pick<AppPrizeTirada, 'prizeId' | 'prizeTitle' | 'picks'>, quantity: number): AppDrawPick[] {
	return (tirada.picks ?? []).map((pick) => ({
		prizeId: tirada.prizeId,
		prizeTitle: unitLabel({ title: tirada.prizeTitle, quantity }, pick.slot),
		slot: pick.slot,
		role: 'winner',
		rank: 1,
		entryNumber: pick.entryNumber,
		maskedName: pick.maskedName
	}));
}

export interface PrizeTiradaRow {
	key: string;
	sequence: number;
	prizeTitle: string;
	units: string;
	drandRound: number;
	committedAt: string;
	candidates: string;
	hash: string;
	state: AppPrizeTirada['state'];
}

/** The "Registro de tiradas" of the app prizes, by round then sequence. */
export function prizeTiradaRows(view: Pick<DrawRoomView, 'appPrizes'>): PrizeTiradaRow[] {
	return (view.appPrizes?.prizes ?? [])
		.flatMap((prize) => prize.tiradas)
		.sort((a, b) => a.round - b.round || a.sequence - b.sequence)
		.map((tirada) => ({
			key: `${tirada.round}-${tirada.sequence}`,
			sequence: tirada.sequence,
			prizeTitle: tirada.prizeTitle,
			units: unitsLabel(tirada.units.length),
			drandRound: tirada.drandRound,
			committedAt: tirada.committedAt,
			candidates: `Entre ${candidatesLabel(tirada.candidateCount)}`,
			hash: onAirHash(tirada.candidateSha256),
			state: tirada.state
		}));
}

// ─── Broadcast mode ───────────────────────────────────────────────────────

/** The query flag of the broadcast mode, so a reload keeps it. */
export const BROADCAST_PARAM = 'transmision';

/** A SHA-256 as the air shows it: never in full. */
export const onAirHash = (hash: string) => `${hash.slice(0, 8)}…${hash.slice(-8)}`;

/**
 * What the broadcast shows of a unit: the prize, the coupon and the name the
 * holder allows; never how it was decided internally beyond the public label.
 */
export function onAirRow(row: UnitRow): { label: string; entryNumber: string | null; name: string | null; state: string } {
	return { label: row.label, entryNumber: row.holder?.entryNumber ?? null, name: row.holder?.name || null, state: unitStateLabel[row.state] };
}
