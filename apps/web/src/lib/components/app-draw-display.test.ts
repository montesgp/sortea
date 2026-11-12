import type { Component } from 'svelte';
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import CampaignPage from '../../routes/(campaign)/sorteos/[slug]/+page.svelte';
import TransparencyPage from '../../routes/(campaign)/sorteos/[slug]/transparencia/+page.svelte';
import AwardsPage from '../../routes/admin/(app)/campanas/[id]/premios/+page.svelte';

// ADR 0024 §5-§7 (odd/tasks/owner-feedback-2026-11-11b.md S10, L14): the back office
// offers the in-app draw where the vacancy shows, and the public site says which
// awards came from it and publishes its record.

const text = (html: string) =>
	html
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/<[^>]+>/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
const html = (component: Component<never>, props: Record<string, unknown>) => render(component as Component, { props: props as never }).body;
const timezone = 'America/Argentina/Buenos_Aires';
const hash = 'c0ffee00'.repeat(8);

describe('awards board entry point', () => {
	const award = { id: 'a1', role: 'winner', rank: 1, status: 'pending_verification', source: 'app_draw', entryNumber: 2, entryVoidedAfterClose: false, active: true, operable: true, notes: 'Sorteo en la app', decidedAt: null, holder: null, fulfillment: null };
	const board = (appDraw: { state: string; round: number; drawnAt: string | null; reason: string | null }, slot: Record<string, unknown>) => ({
		campaign: { id: 'c1', title: 'Moto', status: 'awarding', timezone, entryDigits: 4, round: 1 },
		mechanismRecorded: true,
		resultsPublished: false,
		canOperate: true,
		piiVisible: false,
		appDraw,
		quinielaDraw: null,
		prizes: [{ id: 'moto', position: 1, kind: 'vehicle', title: 'Moto', quantity: 1, alternatesCount: 1, mechanism: 'quiniela', slots: [{ slot: 1, canRecord: false, ...slot }] }]
	});

	it('offers the in-app draw when the Quiniela left a prize vacant', () => {
		const body = html(AwardsPage, { data: { board: board({ state: 'ready', round: 1, drawnAt: null, reason: null }, { state: 'vacant', awards: [] }), appDrawCandidates: 3 }, form: null });
		expect(body).toContain('href="/admin/campanas/c1/sorteo-app"');
		expect(text(body)).toContain('Sortear premios vacantes en la app');
		expect(text(body)).toContain('La Quiniela dejó 1 premio vacante. La plataforma lo sortea entre los 3 cupones sin premio con un número aleatorio criptográfico.');
	});

	it('offers the replay once drawn, and labels the awards it decided', () => {
		const body = html(AwardsPage, { data: { board: board({ state: 'drawn', round: 1, drawnAt: '2026-11-30T01:00:00Z', reason: null }, { state: 'verifying', awards: [award] }), appDrawCandidates: null }, form: null });
		expect(body).toContain('href="/admin/campanas/c1/sorteo-app"');
		expect(text(body)).toContain('Ver el sorteo en la app');
		expect(text(body)).not.toContain('Sortear premios vacantes en la app');
		expect(text(body)).toMatch(/Ganador N\.º 0002 .*Sorteo en la app/);
	});

	it('offers nothing when no prize is vacant', () => {
		const body = html(AwardsPage, { data: { board: board({ state: 'unavailable', round: 1, drawnAt: null, reason: 'No hay premios vacantes para sortear en la aplicación' }, { state: 'empty', awards: [] }), appDrawCandidates: null }, form: null });
		expect(body).not.toContain('/sorteo-app');
	});
});

describe('public labels', () => {
	const campaign = {
		slug: 'moto',
		title: 'Moto 0 km',
		subtitle: null,
		summary: 'Campaña',
		status: 'awarding',
		isDemo: false,
		timezone,
		opensAt: '2026-10-20T00:00:00Z',
		closesAt: '2026-11-28T23:00:00Z',
		drawAt: null,
		streamUrl: null,
		replayUrl: null,
		video: null,
		productIds: [],
		modality: null,
		authority: null,
		seo: {},
		acceptingParticipations: false,
		round: 1,
		carriedOver: [],
		compliance: { allowed: true, demo: false, approvals: [] },
		rules: null,
		qualifyingVariants: [],
		chancesPerUnit: {},
		maxChancesPerIdentity: null,
		entryDigits: 4,
		couponsRemaining: 10,
		soldOut: false,
		prizes: [],
		media: [],
		faqs: [],
		winners: [
			{
				position: 1,
				title: 'Moto',
				quantity: 1,
				delivered: 0,
				units: [{ slot: 1, round: 1, role: 'winner', source: 'app_draw', entryNumber: 342, delivered: false, identity: null }]
			},
			{
				position: 2,
				title: '$100.000',
				quantity: 1,
				delivered: 0,
				units: [{ slot: 1, round: 1, role: 'winner', source: 'quiniela', entryNumber: 7, delivered: false, identity: null }]
			}
		],
		serverTime: '2026-12-01T15:00:00Z'
	};

	it('labels the winners of the in-app draw on the campaign page', () => {
		const page = text(html(CampaignPage, { data: { campaign, products: [], chances: null, rulesHtml: null } }));
		expect(page).toMatch(/N\.º 0342 .*Sorteo en la app/);
		expect(page.match(/Sorteo en la app/g)).toHaveLength(1);
	});

	const transparency = (picks: unknown) => ({
		slug: 'moto',
		title: 'Moto',
		status: 'awarding',
		isDemo: false,
		closesAt: '2026-11-28T23:00:00Z',
		drawAt: null,
		streamUrl: null,
		replayUrl: null,
		entryDigits: 4,
		round: 1,
		totals: { eligibleEntries: 3, participants: 2, voidedEntries: 0 },
		ruleVersions: [],
		manifest: null,
		manifests: [],
		timeline: [],
		quinielaDraws: [],
		appDraws: [{ round: 1, drawnAt: '2026-11-30T01:00:00.000Z', candidateCount: 3, candidateSha256: hash, candidates: ['0000', '0001', '0342'], picks }],
		awards: picks ? [{ round: 1, prize: 'Moto', slot: 1, role: 'winner', status: 'pending_verification', source: 'app_draw', entryNumber: 342, extractPosition: null, fulfillment: null }] : [],
		vacantSlots: []
	});

	it('publishes the in-app draw record: time, count, hash and the candidate coupons', () => {
		const page = text(html(TransparencyPage, { data: { transparency: transparency(null) } }));
		expect(page).toContain('Sorteo en la app');
		expect(page).toContain('Los premios vacantes se sortearon en la aplicación el 29 de noviembre de 2026 a las 22:00 entre 3 cupones sin premio.');
		expect(page).toContain(hash);
		expect(page).toContain('0000 0001 0342');
		expect(page).toContain("printf '0000\\n0001\\n0342' | sha256sum");
		expect(page).toContain('El resultado se publica con los resultados de la ronda.');
	});

	it('lists its picks and labels its awards once the results are published', () => {
		const page = text(html(TransparencyPage, { data: { transparency: transparency([{ prize: 'Moto', slot: 1, role: 'winner', rank: 1, entryNumber: '0342' }]) } }));
		expect(page).toContain('Moto, unidad 1: Ganador, cupón 0342');
		expect(page).toMatch(/Moto Cupón N\.º 0342 Ganador Sorteo en la app/);
	});
});
