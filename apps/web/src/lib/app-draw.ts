/**
 * The in-app draw of vacant prizes as the back office presents it (ADR 0024 §5;
 * odd/tasks/owner-feedback-2026-11-11b.md S10, L14). The API draws and stores
 * the result before answering; this module only decides how the stored result
 * is shown: the reel of candidates, its motion, its labels and its sound.
 *
 * The reel is a strip of rows that repeats every `length` rows: row `k` shows
 * candidate `strip[k mod length]`. A spin moves the centre of the screen from
 * row `start` to row `start + distance` along a deterministic curve (ease-in,
 * cruise, ease-out), and `distance` is chosen so the last row is the stored
 * pick. Nothing random happens in the browser except the display order, which
 * is a seeded shuffle and decides nothing.
 */

export interface AppDrawCandidate {
	/** Zero-padded to the campaign's digits, shown in full. */
	entryNumber: string;
	/** "Ju*** P.": the only identity the screen shows. */
	maskedName: string;
}

export interface AppDrawCampaign {
	id: string;
	title: string;
	round: number;
	entryDigits: number;
	timezone: string;
}

/** `GET /admin/campaigns/:id/app-draw/preview`: what would be drawn, written nowhere. */
export interface AppDrawPreview {
	campaign: AppDrawCampaign;
	vacant: { prizeId: string; prizeTitle: string; slot: number; alternatesCount: number }[];
	candidates: AppDrawCandidate[];
	candidateCount: number;
	candidateSha256: string;
}

export interface AppDrawPick extends AppDrawCandidate {
	prizeId: string;
	prizeTitle: string;
	slot: number;
	role: 'winner' | 'alternate';
	rank: number;
}

/** The stored draw (`POST` and `GET /admin/campaigns/:id/app-draw`); `picks` in draw order. */
export interface AppDrawResult {
	campaign: AppDrawCampaign;
	round: number;
	drawnAt: string;
	candidateCount: number;
	candidateSha256: string;
	picks: AppDrawPick[];
	candidates: AppDrawCandidate[];
}

/** `appDraw` of the awards board and the campaign detail. */
export interface AppDrawState {
	state: 'ready' | 'drawn' | 'unavailable';
	round: number;
	drawnAt: string | null;
	reason: string | null;
	/** Coupons in play, counted by the API (T13): live while `ready` (0 when none is left), the stored draw's once `drawn`, else null. */
	candidateCount: number | null;
}

// ─── Reel geometry and motion ─────────────────────────────────────────────

/** Rows shown above and below the centre row. */
export const REEL_RADIUS = 5;
/**
 * The frame rate a stream is captured at. A paused frame must show readable
 * rows, so the reel never passes more than `REEL_RADIUS` rows per captured
 * frame: every row crosses the centre window in some captured frame. Rows are
 * sized from the viewport, so at 720p about 7 rows are visible and a row stays
 * on screen for one or two frames at full speed.
 */
export const REEL_FRAME_RATE = 30;
const MAX_ROWS_PER_SECOND = REEL_RADIUS * REEL_FRAME_RATE;

const spins = {
	// About 8 s: a short spin-up, the fast phase, and a long ease-out (S10: "hasta que para").
	winner: { accel: 0.4, cruise: 2, decel: 6, minSpeed: 60, fullLap: true },
	// About 3 s: alternates follow the winner of the same prize.
	alternate: { accel: 0.3, cruise: 0.7, decel: 2, minSpeed: 120, fullLap: false }
} as const;
/** Cubic ease-out: smooth, and its speed at the start of the deceleration matches the cruise. */
const POWER = 3;

export interface SpinPlan {
	length: number;
	/** Row at the centre when the spin starts. */
	start: number;
	/** Strip index of the stored pick. */
	target: number;
	/** Rows travelled; `start + distance` shows the target. */
	distance: number;
	/** Rows per second of the fast phase. */
	velocity: number;
	/** Seconds of each phase. */
	accel: number;
	cruise: number;
	decel: number;
	power: number;
	duration: number;
}

const mod = (value: number, length: number) => ((value % length) + length) % length;

/**
 * The motion that lands on `target`. A winner spin travels at least one whole
 * lap, so every candidate crosses the centre; small lists loop several times so
 * the reel still looks fast. Without `start`, the spin starts where it lands in
 * exactly the minimum distance. The durations are fixed unless the list is so
 * long that one lap would pass rows faster than a captured frame shows them:
 * then the fast phase lasts longer at the speed limit.
 */
export function planSpin(input: { length: number; target: number; start?: number; kind: 'winner' | 'alternate' }): SpinPlan {
	const { length, target, kind } = input;
	const spin = spins[kind];
	const fixed = spin.accel / 2 + spin.decel / POWER;
	const minimum = Math.max(spin.fullLap ? length : 1, Math.ceil(spin.minSpeed * (fixed + spin.cruise)));
	const start = input.start ?? target - minimum;
	const distance = minimum + mod(target - (start + minimum), length);
	let cruise: number = spin.cruise;
	let velocity = distance / (fixed + cruise);
	if (velocity > MAX_ROWS_PER_SECOND) {
		velocity = MAX_ROWS_PER_SECOND;
		cruise = distance / velocity - fixed;
	}
	return { length, start, target, distance, velocity, accel: spin.accel, cruise, decel: spin.decel, power: POWER, duration: spin.accel + cruise + spin.decel };
}

/** Row at the centre `t` seconds into the spin; exactly `start + distance` from the end on. */
export function spinPosition(plan: SpinPlan, t: number): number {
	const { start, velocity: v, accel, cruise, decel, power } = plan;
	if (t <= 0) return start;
	if (t >= plan.duration) return start + plan.distance;
	if (t < accel) return start + (v * t * t) / (2 * accel);
	const afterAccel = (v * accel) / 2;
	if (t < accel + cruise) return start + afterAccel + v * (t - accel);
	const u = (t - accel - cruise) / decel;
	const decelDistance = (v * decel) / power;
	return start + afterAccel + v * cruise + decelDistance * (1 - (1 - u) ** power);
}

/** Rows per second `t` seconds into the spin. */
export function spinVelocity(plan: SpinPlan, t: number): number {
	const { velocity: v, accel, cruise, decel, power } = plan;
	if (t <= 0 || t >= plan.duration) return 0;
	if (t < accel) return (v * t) / accel;
	if (t < accel + cruise) return v;
	const u = (t - accel - cruise) / decel;
	return v * (1 - u) ** (power - 1);
}

/** Fastest speed any spin reaches, to scale the tick sound. */
export const REEL_MAX_SPEED = MAX_ROWS_PER_SECOND;

export interface ReelRow {
	/** Absolute row number: stable key while the reel moves. */
	row: number;
	/** Strip index shown in that row. */
	index: number;
	/** Rows from the centre; negative is above. */
	offset: number;
}

/** The only rows rendered: the centre and `radius` rows each side, plus the one entering. */
export function reelWindow(position: number, length: number, radius = REEL_RADIUS): ReelRow[] {
	const base = Math.floor(position);
	const rows: ReelRow[] = [];
	for (let row = base - radius; row <= base + radius + 1; row++) rows.push({ row, index: mod(row, length), offset: row - position });
	return rows;
}

/** A seeded shuffle of `0 … count − 1` for display only (FNV-1a seed, mulberry32 steps). */
export function displayOrder(count: number, seed: string): number[] {
	let state = 0x811c9dc5;
	for (let index = 0; index < seed.length; index++) state = Math.imul(state ^ seed.charCodeAt(index), 0x01000193) >>> 0;
	const next = () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let value = state;
		value = Math.imul(value ^ (value >>> 15), value | 1);
		value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
		return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
	};
	const order = Array.from({ length: count }, (_, index) => index);
	for (let index = count - 1; index > 0; index--) {
		const other = Math.floor(next() * (index + 1));
		[order[index], order[other]] = [order[other]!, order[index]!];
	}
	return order;
}

/**
 * The reel of pick `index`: every candidate still in play (earlier picks
 * cannot win again), in the display order, and where the pick sits in it.
 */
export function reelStrip(candidates: readonly AppDrawCandidate[], picks: readonly AppDrawPick[], index: number, seed: string): { strip: AppDrawCandidate[]; target: number } {
	const taken = new Set(picks.slice(0, index).map((pick) => pick.entryNumber));
	const strip = displayOrder(candidates.length, seed)
		.map((position) => candidates[position]!)
		.filter((candidate) => !taken.has(candidate.entryNumber));
	const pick = picks[index]!;
	let target = strip.findIndex((candidate) => candidate.entryNumber === pick.entryNumber);
	if (target === -1) {
		strip.push({ entryNumber: pick.entryNumber, maskedName: pick.maskedName });
		target = strip.length - 1;
	}
	return { strip, target };
}

/** Pitch and volume of the tick of a row crossing the centre, from the reel speed (0 to 1). */
export function tickTone(speed: number): { frequency: number; gain: number } {
	const s = Math.min(1, Math.max(0, speed));
	return { frequency: 900 + 1500 * s, gain: 0.04 + 0.16 * s };
}

// ─── Labels ───────────────────────────────────────────────────────────────

/** "0342 · Ju*** P.": the coupon in full and the masked name, nothing else. */
export const rowLabel = (candidate: AppDrawCandidate) => `${candidate.entryNumber} · ${candidate.maskedName}`;

export const pickRole = (pick: Pick<AppDrawPick, 'role' | 'rank'>) => (pick.role === 'winner' ? 'Ganador' : `Suplente ${pick.rank}`);

/** "Ganador del Moto: cupón 0342, Ju*** P." (the masked name ends the sentence), for the live region; the unit only when the prize has several. */
export function pickAnnouncement(pick: AppDrawPick, withUnit = false): string {
	return `${pickRole(pick)} del ${pick.prizeTitle}${withUnit ? `, unidad ${pick.slot}` : ''}: cupón ${pick.entryNumber}, ${pick.maskedName}`;
}

/** "Sorteando: Ganador del Moto.", set when the reel starts and kept until it stops. */
export function spinAnnouncement(pick: AppDrawPick, withUnit = false): string {
	return `Sorteando: ${pickRole(pick)} del ${pick.prizeTitle}${withUnit ? `, unidad ${pick.slot}` : ''}.`;
}

/** Whether the picks name more than one unit of some prize, so labels must say which. */
export function picksNeedUnit(picks: readonly Pick<AppDrawPick, 'prizeId' | 'slot'>[]): boolean {
	return picks.some((pick) => picks.some((other) => other.prizeId === pick.prizeId && other.slot !== pick.slot));
}

// ─── Side table (odd/tasks/owner-feedback-2026-11-12.md S3) ──────────────

/** A pick in the side table: revealed, on the reel now, or still to draw. */
export type TallyRowState = 'done' | 'current' | 'pending';

/** The state of pick `row` while pick `current` spins, or once it `landed`. */
export function tallyRowState(row: number, current: number, landed: boolean): TallyRowState {
	if (row < current || (row === current && landed)) return 'done';
	return row === current ? 'current' : 'pending';
}

/** "2 de 4": how many picks the screen already revealed. */
export const tallyProgress = (current: number, total: number, landed: boolean) => `${current + (landed ? 1 : 0)} de ${total}`;

export const shortHash = (hash: string) => `${hash.slice(0, 8)}…${hash.slice(-8)}`;

const count = new Intl.NumberFormat('es-AR');

/** What the in-app draw does, for the awards board: how many prizes and among how many coupons. */
export function appDrawSummary(vacant: number, candidates: number | null): string {
	const prizes = vacant === 1 ? 'La Quiniela dejó 1 premio vacante.' : `La Quiniela dejó ${count.format(vacant)} premios vacantes.`;
	const them = vacant === 1 ? 'lo' : 'los';
	const among =
		candidates === 1
			? `La plataforma ${them} sortea con el único cupón sin premio que queda.`
			: `La plataforma ${them} sortea entre los ${candidates === null ? '' : `${count.format(candidates)} `}cupones sin premio con un número aleatorio criptográfico.`;
	return `${prizes} ${among}`;
}

/** The public label of an award's source; only the in-app draw is labelled. */
export function awardSourceLabel(source: string | null | undefined): string | null {
	return source === 'app_draw' ? 'Sorteo en la app' : null;
}

/**
 * Where the site serves a round's candidate list (ADR 0024 §6; T13): the API's
 * canonical text, one coupon per line and no final newline, whose SHA-256 is
 * the published one.
 */
export const candidateListHref = (slug: string, round: number) => `/sorteos/${slug}/sorteo-app/${round}/cupones.txt`;

/** Its download name, which the verification commands name. */
export const candidateListFile = (slug: string, round: number) => `${slug}-cupones-sorteo-app-ronda-${round}.txt`;

/** The round of a candidate-list address, or null when it is not a round number. */
export function candidateListRound(value: string): number | null {
	if (!/^[1-9]\d{0,4}$/.test(value)) return null;
	return Number(value);
}
