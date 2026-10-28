import { describe, expect, it } from 'vitest';
import { autoSubmitReady, historyItem, lookupView, parseHistory, type CouponLookup } from './coupon-lookup';

const base: CouponLookup = {
	campaign: { id: 'c1', title: 'Moto 0 km', entryDigits: 4, round: 1, status: 'awarding' },
	coupon: { entryNumber: 42, label: '0042' },
	outcome: 'eligible',
	manifest: { round: 1, status: 'eligible' },
	awards: [],
	identity: { visibility: 'not_applicable' }
};
const lookup = (overrides: Partial<CouponLookup>): CouponLookup => ({ ...base, ...overrides });
const award = { prize: 'Moto', position: 1, slot: 1, round: 1, role: 'winner' as const, rank: 1, status: 'pending_verification' };
const ana = { visibility: 'shown' as const, name: 'Ana Sorteada', city: 'Zapala', chances: 3 };

describe('lookupView (S7)', () => {
	it('shows a winner with full name, city and chances when they consented', () => {
		expect(lookupView(lookup({ awards: [award], identity: ana }))).toEqual({
			kind: 'winner',
			tone: 'win',
			coupon: 'N.º 0042',
			headline: 'Cupón ganador',
			prize: 'Moto',
			identity: { name: 'Ana Sorteada', place: 'de Zapala', chances: '3 chances obtenidas' },
			note: null
		});
	});

	it('withholds the identity of a winner who did not consent, with the reserved message', () => {
		expect(lookupView(lookup({ awards: [award], identity: { visibility: 'withheld' } }))).toMatchObject({
			kind: 'winner',
			headline: 'Cupón ganador',
			identity: null,
			note: 'El ganador se reservó el derecho de no mostrar su identidad'
		});
	});

	it('names an alternate by rank, a later round and a decision already taken', () => {
		const view = lookupView(lookup({ awards: [{ ...award, role: 'alternate', rank: 2, round: 2, status: 'declined' }], identity: { ...ana, city: null, chances: 1 } }));
		expect(view).toMatchObject({ kind: 'alternate', tone: 'win', headline: 'Suplente 2', prize: 'Moto, ronda 2', note: 'Rechazó o no reclamó' });
		expect(view.identity).toEqual({ name: 'Ana Sorteada', place: null, chances: '1 chance obtenida' });
	});

	it('says a sold coupon without a prize plays the draw once the manifest is published', () => {
		expect(lookupView(lookup({ identity: ana }))).toMatchObject({ kind: 'plays', tone: 'ok', headline: 'Cupón vendido y habilitado: participa del sorteo', prize: null, note: 'El titular se muestra solo si el cupón resulta adjudicado al cargar el sorteo' });
		expect(lookupView(lookup({ identity: { visibility: 'withheld' } }))).toMatchObject({ kind: 'plays', identity: null, note: 'El ganador se reservó el derecho de no mostrar su identidad' });
	});

	it('says a sold coupon is eligible, without identity, while the campaign sells', () => {
		expect(lookupView(lookup({ manifest: null }))).toEqual({
			kind: 'sold',
			tone: 'ok',
			coupon: 'N.º 0042',
			headline: 'Cupón vendido y habilitado',
			prize: null,
			identity: null,
			note: 'Entra al sorteo cuando se publique el manifiesto'
		});
	});

	it('says a void coupon does not play, and a coupon nobody bought was not sold', () => {
		expect(lookupView(lookup({ outcome: 'void', manifest: { round: 1, status: 'void' } }))).toMatchObject({
			kind: 'void',
			tone: 'bad',
			headline: 'Cupón anulado',
			identity: null,
			note: 'No participa del sorteo: su compra se anuló o se reembolsó'
		});
		expect(lookupView(lookup({ outcome: 'not_sold', manifest: { round: 1, status: null } }))).toMatchObject({
			kind: 'not_sold',
			tone: 'neutral',
			headline: 'Cupón no vendido',
			identity: null,
			note: 'Nadie compró este número en esta campaña'
		});
	});
});

describe('session history (S7)', () => {
	it('keeps the coupon and a short outcome, never who holds it', () => {
		expect(historyItem(lookup({ awards: [award], identity: ana }))).toEqual({ coupon: '0042', kind: 'winner', summary: 'Ganador · Moto' });
		expect(historyItem(lookup({ awards: [{ ...award, role: 'alternate', rank: 1 }], identity: ana }))).toEqual({ coupon: '0042', kind: 'alternate', summary: 'Suplente 1 · Moto' });
		expect(historyItem(lookup({ identity: ana }))).toEqual({ coupon: '0042', kind: 'plays', summary: 'Participa del sorteo' });
		expect(historyItem(lookup({ manifest: null }))).toEqual({ coupon: '0042', kind: 'sold', summary: 'Vendido' });
		expect(historyItem(lookup({ outcome: 'void', manifest: { round: 1, status: 'void' } }))).toEqual({ coupon: '0042', kind: 'void', summary: 'Anulado' });
		// Refunded after the close: the frozen manifest still lists it, so it plays (ADR 0003, ADR 0014 §4).
		expect(historyItem(lookup({ outcome: 'void' }))).toEqual({ coupon: '0042', kind: 'plays', summary: 'Participa del sorteo' });
		expect(historyItem(lookup({ outcome: 'not_sold' }))).toEqual({ coupon: '0042', kind: 'not_sold', summary: 'No vendido' });
	});

	it('reads back the history a plain form posted, dropping anything malformed', () => {
		const items = [{ coupon: '0042', kind: 'winner', summary: 'Ganador · Moto' }];
		expect(parseHistory(JSON.stringify(items))).toEqual(items);
		expect(parseHistory('')).toEqual([]);
		expect(parseHistory('not json')).toEqual([]);
		expect(parseHistory(JSON.stringify([{ coupon: '0042', kind: 'hacked', summary: 'x' }]))).toEqual([]);
		expect(parseHistory(JSON.stringify(Array.from({ length: 150 }, () => items[0])))).toHaveLength(100);
	});
});

describe('autoSubmitReady (S7)', () => {
	it('submits once the coupon has all its digits, spaces aside', () => {
		expect(autoSubmitReady('0042', 4)).toBe(true);
		expect(autoSubmitReady('00 42', 4)).toBe(true);
		expect(autoSubmitReady('042', 4)).toBe(false);
		expect(autoSubmitReady('00042', 4)).toBe(false);
		expect(autoSubmitReady('00a2', 4)).toBe(false);
	});
});
