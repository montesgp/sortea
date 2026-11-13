import type { Component } from 'svelte';
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import { manifestRound } from '#lib/quiniela.js';
import CampaignPage from '../../routes/(campaign)/sorteos/[slug]/+page.svelte';
import TransparencyPage from '../../routes/(campaign)/sorteos/[slug]/transparencia/+page.svelte';
import CampaignAdminPage from '../../routes/admin/(app)/campanas/[id]/+page.svelte';
import AwardsPage from '../../routes/admin/(app)/campanas/[id]/premios/+page.svelte';

// ADR 0014 §5: a campaign already reopened plays a new round (ADR 0024 §7: the back office no longer reopens).
// The campaign page says which round it is, what is carried over and when it
// closes; transparency lists each round's manifest, draw and vacancies.

const text = (html: string) =>
	html
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/<[^>]+>/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
const html = (component: Component<never>, props: Record<string, unknown>) => render(component as Component, { props: props as never }).body;
const timezone = 'America/Argentina/Buenos_Aires';
const extracts = (first: number) => [first, ...Array.from({ length: 19 }, (_, index) => 1_000 + index)];

describe('campaign page', () => {
	const campaign = (round: number, carriedOver: { prize: string; slot: number }[]) => ({
		slug: 'moto',
		title: 'Moto 0 km',
		subtitle: null,
		summary: 'Campaña',
		status: 'open',
		isDemo: false,
		timezone,
		opensAt: '2026-10-20T00:00:00Z',
		closesAt: '2026-12-20T23:00:00Z',
		drawAt: null,
		streamUrl: null,
		replayUrl: null,
		video: null,
		productIds: [],
		modality: null,
		authority: null,
		seo: {},
		acceptingParticipations: true,
		round,
		carriedOver,
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
		serverTime: '2026-12-01T15:00:00Z'
	});
	const page = (round: number, carriedOver: { prize: string; slot: number }[]) =>
		text(html(CampaignPage, { data: { campaign: campaign(round, carriedOver), products: [], chances: null, rulesHtml: null } }));

	it('announces the round, the vacant prizes it decides and its closing date', () => {
		const body = page(2, [
			{ prize: 'Moto', slot: 1 },
			{ prize: '$100.000', slot: 2 },
			{ prize: '$100.000', slot: 3 }
		]);
		expect(body).toContain('Ronda 2');
		expect(body).toContain('Premios vacantes que se sortean en esta ronda: Moto, $100.000 (2 unidades). La ronda cierra el 20 de diciembre de 2026 a las 20:00.');
		expect(body).toContain('Los cupones de las rondas anteriores siguen participando.');
	});

	it('says nothing about rounds in the first one', () => {
		const body = page(1, []);
		expect(body).not.toContain('Ronda');
		expect(body).not.toContain('vacantes');
	});
});

describe('transparency per round', () => {
	const hash = (char: string) => char.repeat(64);
	const transparency = {
		slug: 'moto',
		title: 'Moto',
		status: 'awarding',
		isDemo: false,
		closesAt: '2026-12-20T23:00:00Z',
		drawAt: null,
		streamUrl: null,
		replayUrl: null,
		entryDigits: 4,
		round: 2,
		totals: { eligibleEntries: 6, participants: 3, voidedEntries: 0 },
		ruleVersions: [],
		manifest: { round: 2, sha256: hash('b'), eligibleCount: 6, voidCount: 0, closedAt: '2026-12-20T23:00:00Z', publishedAt: '2026-12-21T00:00:00Z' },
		manifests: [
			{ round: 1, sha256: hash('a'), eligibleCount: 4, voidCount: 0, closedAt: '2026-11-28T23:00:00Z', publishedAt: '2026-11-29T01:00:00Z' },
			{ round: 2, sha256: hash('b'), eligibleCount: 6, voidCount: 0, closedAt: '2026-12-20T23:00:00Z', publishedAt: '2026-12-21T00:00:00Z' }
		],
		timeline: [{ round: 2, kind: 'round_opened', title: 'Ronda 2 abierta', detail: 'Cierra el 20/12/2026 a las 20:00. Premios vacantes que se sortean en esta ronda: Moto.', evidenceUrl: null, occurredAt: '2026-11-30T12:00:00Z' }],
		quinielaDraws: [
			{ round: 1, source: 'Quiniela de la Ciudad, Nocturna', drawnAt: '2026-11-30T00:00:00.000Z', extracts: extracts(2), evidenceUrl: 'https://loteria.example/r1.pdf', manifestSha256: hash('a'), recordedAt: '2026-11-30T12:00:00Z' },
			{ round: 2, source: 'Quiniela de la Ciudad, Vespertina', drawnAt: '2026-12-21T21:00:00.000Z', extracts: extracts(5), evidenceUrl: 'https://loteria.example/r2.pdf', manifestSha256: hash('b'), recordedAt: '2026-12-22T12:00:00Z' }
		],
		awards: [
			{ round: 1, prize: '$100.000', slot: 1, role: 'winner', status: 'accepted', entryNumber: 2, extractPosition: 1, fulfillment: null },
			{ round: 2, prize: 'Moto', slot: 1, role: 'winner', status: 'pending_verification', entryNumber: 5, extractPosition: 1, fulfillment: null }
		],
		vacantSlots: [{ round: 1, prize: 'Moto', slot: 1 }]
	};

	it('lists each round manifest with its hash, counts and own download', () => {
		const body = html(TransparencyPage, { data: { transparency } });
		const page = text(body);
		expect(page).toContain(`Ronda 1 Publicada el 28 de noviembre de 2026 a las 22:00 con 4 participaciones válidas. Huella SHA-256 ${hash('a')}`);
		expect(page).toContain(`Ronda 2 Publicada el 20 de diciembre de 2026 a las 21:00 con 6 participaciones válidas. Huella SHA-256 ${hash('b')}`);
		expect(body).toContain('href="/sorteos/moto/manifiesto?ronda=1"');
		expect(body).toContain('href="/sorteos/moto/manifiesto?ronda=2"');
	});

	it('lists each round draw with the manifest it was matched against', () => {
		const page = text(html(TransparencyPage, { data: { transparency } }));
		expect(page).toContain('Sorteo de la Quiniela, ronda 1 Quiniela de la Ciudad, Nocturna, sorteo del 29/11/2026 a las 21:00.');
		expect(page).toContain('Sorteo de la Quiniela, ronda 2 Quiniela de la Ciudad, Vespertina, sorteo del 21/12/2026 a las 18:00.');
		expect(page).toContain(`Comparado con la lista de la ronda 2 (huella ${hash('b')}).`);
	});

	it('tells which round each award and each vacancy belongs to, and the round of each log entry', () => {
		const page = text(html(TransparencyPage, { data: { transparency } }));
		expect(page).toContain('$100.000 Cupón N.º 0002 Ganador Ronda 1 extracto 1.º');
		expect(page).toContain('Moto Cupón N.º 0005 Ganador Ronda 2 extracto 1.º');
		expect(page).toContain('Moto, unidad 1 Vacante en la ronda 1');
		expect(page).toContain('Ronda 2 abierta');
	});

	it('keeps a single-round campaign as before', () => {
		const single = {
			...transparency,
			round: 1,
			manifest: transparency.manifests[0],
			manifests: [transparency.manifests[0]],
			quinielaDraws: [transparency.quinielaDraws[0]],
			awards: [transparency.awards[0]],
			vacantSlots: [{ round: 1, prize: 'Moto', slot: 1 }],
			timeline: []
		};
		const body = html(TransparencyPage, { data: { transparency: single } });
		const page = text(body);
		expect(page).not.toContain('Ronda');
		expect(page).not.toContain('ronda');
		expect(page).toContain('Moto, unidad 1 Vacante');
		expect(body).toContain('href="/sorteos/moto/manifiesto"');
	});
});

describe('vacancies in the admin (ADR 0024 §7, L14)', () => {
	const campaign = (appDraw: { state: string; round: number; drawnAt: string | null; reason: string | null }) => ({
		id: 'c1',
		productIds: [],
		products: [],
		slug: 'moto',
		title: 'Moto',
		subtitle: null,
		summary: 'S',
		status: 'awarding',
		isDemo: false,
		timezone,
		opensAt: '2026-10-20T00:00:00Z',
		closesAt: '2026-11-28T23:00:00Z',
		drawAt: null,
		streamUrl: null,
		replayUrl: null,
		video: null,
		requiredApprovals: [],
		gate: { allowed: true, missing: [], rejected: [] },
		allowedTransitions: ['fulfilled'],
		canClose: false,
		currentRound: 1,
		vacantSlots: [{ prize: 'Moto', slot: 1 }],
		// The API still answers these for campaigns already reopened; the back office no longer offers reopening.
		canReopen: true,
		reopenBlocked: null,
		appDraw,
		approvals: [],
		rules: [],
		chanceVariants: [],
		prizes: [],
		events: [],
		manifest: { round: 1, sha256: 'a'.repeat(64), eligibleCount: 4, voidCount: 0, publishedAt: '2026-11-29T01:00:00Z' },
		totals: { eligibleEntries: 4, participants: 2 }
	});
	const page = (appDraw: { state: string; round: number; drawnAt: string | null; reason: string | null }, permissions = ['campaigns.manage', 'campaigns.operate']) =>
		html(CampaignAdminPage, {
			data: { campaign: campaign(appDraw), prizeEditor: { prizes: [], editable: false, videoEditable: false, videos: [] }, session: { organization: { currency: 'ARS' }, permissions } },
			form: null
		});
	const ready = { state: 'ready', round: 1, drawnAt: null, reason: null };

	it('never offers reopening, even when the API would allow it', () => {
		const body = page(ready);
		expect(body).not.toMatch(/action="\?\/reopen"/);
		expect(text(body)).not.toContain('Abrir la ronda 2');
		expect(body).not.toMatch(/name="closesAt"[^>]*required/);
	});

	it('points to the in-app draw of the vacant prizes instead', () => {
		const body = page(ready);
		expect(text(body)).toContain('Vacantes de la ronda 1: Moto.');
		expect(body).toContain('href="/admin/campanas/c1/sorteo-app"');
		expect(text(body)).toContain('Sortear premios vacantes en la app');
		expect(text(page({ state: 'drawn', round: 1, drawnAt: '2026-11-30T01:00:00Z', reason: null }))).toContain('Ver el sorteo en la app');
	});

	// Owner feedback 2026-11-12 S8: with the campaign open nothing showed where the tool is.
	it('says where the in-app draw is and when it opens while it is not available yet', () => {
		const open = html(CampaignAdminPage, {
			data: {
				campaign: { ...campaign({ state: 'unavailable', round: 1, drawnAt: null, reason: 'Las adjudicaciones se registran con la campaña en adjudicación' }), status: 'open', vacantSlots: [] },
				prizeEditor: { prizes: [], editable: false, videoEditable: false, videos: [] },
				session: { organization: { currency: 'ARS' }, permissions: ['campaigns.manage', 'campaigns.operate'] }
			},
			form: null
		});
		expect(text(open)).toContain('Sorteo en la app de los premios vacantes');
		expect(text(open)).toContain('Se habilita acá después del cierre, cuando cargues el resultado de la Quiniela y algún premio quede sin cupón ganador.');
		expect(open).not.toContain('/sorteo-app');
		const awarding = text(page({ state: 'unavailable', round: 1, drawnAt: null, reason: 'No hay premios vacantes para sortear en la aplicación' }));
		expect(awarding).toContain('Sorteo en la app de los premios vacantes');
		expect(awarding).toContain('No hay premios vacantes para sortear en la aplicación');
		expect(text(page(ready))).not.toContain('Se habilita acá');
	});

	it('offers nothing without permission to operate the campaign or while nothing is vacant', () => {
		expect(page(ready, ['campaigns.manage'])).not.toContain('/sorteo-app');
		expect(page({ state: 'unavailable', round: 1, drawnAt: null, reason: 'No hay premios vacantes para sortear en la aplicación' })).not.toContain('/sorteo-app');
	});
});

describe('manifest download per round', () => {
	it('accepts only a positive round number', () => {
		expect(manifestRound('2')).toBe(2);
		expect(manifestRound(null)).toBeNull();
		for (const value of ['0', '-1', '1.5', 'x', '']) expect(manifestRound(value), value).toBeNull();
	});
});

describe('awards page while round 2 is open (ADR 0014 §5)', () => {
	const award = (id: string, operable: boolean, status = 'pending_verification') => ({
		id,
		role: 'winner',
		rank: 1,
		status,
		entryNumber: 2,
		entryVoidedAfterClose: false,
		active: true,
		operable,
		notes: null,
		decidedAt: null,
		holder: null,
		fulfillment: status === 'accepted' ? { status: 'pending', scheduledFor: null, deliveredAt: null, evidenceUrl: null, notes: null } : null
	});
	const board = {
		campaign: { id: 'c1', title: 'Moto', status: 'open', timezone, entryDigits: 4, round: 2 },
		mechanismRecorded: true,
		resultsPublished: true,
		canOperate: false,
		piiVisible: false,
		quinielaDraw: null,
		prizes: [
			{ id: 'cash', position: 1, kind: 'cash', title: '$100.000', quantity: 1, alternatesCount: 0, mechanism: 'quiniela', slots: [{ slot: 1, state: 'verifying', canRecord: false, awards: [award('a1', true)] }] },
			{ id: 'kit', position: 2, kind: 'product', title: 'Kit', quantity: 1, alternatesCount: 0, mechanism: 'manual', slots: [{ slot: 1, state: 'accepted', canRecord: false, awards: [award('a2', true, 'accepted')] }] },
			{ id: 'moto', position: 3, kind: 'vehicle', title: 'Moto', quantity: 1, alternatesCount: 0, mechanism: 'quiniela', slots: [{ slot: 1, state: 'verifying', canRecord: false, awards: [award('a3', false)] }] }
		]
	};

	it('keeps decisions and deliveries of earlier rounds open, and only for the awards that allow them', () => {
		const body = html(AwardsPage, { data: { board }, form: null });
		expect(text(body)).toContain('Ronda 2 en curso: las decisiones y entregas de las rondas anteriores siguen abiertas.');
		expect(body).toMatch(/name="awardId" value="a1"/);
		expect(body).toMatch(/action="\?\/fulfill"/);
		expect(body).not.toMatch(/name="awardId" value="a3"/);
	});
});
