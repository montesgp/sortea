import type { Component } from 'svelte';
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import TransparencyPage from '../../routes/(campaign)/sorteos/[slug]/transparencia/+page.svelte';
import CampaignAdminPage from '../../routes/admin/(app)/campanas/[id]/+page.svelte';
import AwardsPage from '../../routes/admin/(app)/campanas/[id]/premios/+page.svelte';

// ADR 0014 §3-§4: the admin previews the matching of the 20 extracts before
// confirming it, and the transparency page shows the draw and which extract
// gave each winner.

const text = (html: string) =>
	html
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/<[^>]+>/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
const html = (component: Component<never>, props: Record<string, unknown>) => render(component as Component, { props: props as never }).body;
const timezone = 'America/Argentina/Buenos_Aires';
const extracts = [9_999, 0, 0, 5, 1, 7, ...Array.from({ length: 14 }, (_, index) => 1_000 + index)];

const board = (overrides: Record<string, unknown> = {}) => ({
	campaign: { id: 'c1', title: 'Moto', status: 'awarding', timezone, entryDigits: 4 },
	mechanismRecorded: false,
	resultsPublished: false,
	canOperate: true,
	piiVisible: false,
	quinielaDraw: null,
	prizes: [
		{ id: 'moto', position: 1, kind: 'vehicle', title: 'Moto', quantity: 1, alternatesCount: 1, mechanism: 'quiniela', slots: [{ slot: 1, state: 'empty', canRecord: false, awards: [] }] },
		{ id: 'cash', position: 2, kind: 'cash', title: '$100.000', quantity: 2, alternatesCount: 0, mechanism: 'quiniela', slots: [{ slot: 1, state: 'empty', canRecord: false, awards: [] }, { slot: 2, state: 'empty', canRecord: false, awards: [] }] },
		{ id: 'kit', position: 3, kind: 'product', title: 'Kit', quantity: 1, alternatesCount: 0, mechanism: 'manual', slots: [{ slot: 1, state: 'empty', canRecord: false, awards: [] }] }
	],
	...overrides
});

const unused = (position: number, number: number, outcome: string) => ({ position, number, outcome, prizeId: null, slot: null, rank: null });
const preview = {
	entryDigits: 4,
	extracts: [
		unused(1, 9_999, 'no_match'),
		{ position: 2, number: 0, outcome: 'winner', prizeId: 'moto', slot: 1, rank: null },
		unused(3, 0, 'repeated'),
		unused(4, 5, 'already_awarded'),
		{ position: 5, number: 1, outcome: 'winner', prizeId: 'cash', slot: 1, rank: null },
		{ position: 6, number: 7, outcome: 'alternate', prizeId: 'moto', slot: 1, rank: 1 },
		...extracts.slice(6).map((number, index) => unused(index + 7, number, 'no_match'))
	],
	slots: [
		{ prizeId: 'moto', prizeTitle: 'Moto', slot: 1, winner: { entryNumber: 0, extract: 2 }, alternates: [{ entryNumber: 7, extract: 6, rank: 1 }] },
		{ prizeId: 'cash', prizeTitle: '$100.000', slot: 1, winner: { entryNumber: 1, extract: 5 }, alternates: [] },
		{ prizeId: 'cash', prizeTitle: '$100.000', slot: 2, winner: null, alternates: [] }
	],
	vacant: [{ prizeId: 'cash', prizeTitle: '$100.000', slot: 2 }],
	digest: 'd'.repeat(64)
};
const input = { source: 'Quiniela de la Ciudad, Nocturna', drawDate: '2026-11-29', drawTime: '21:00', extracts: extracts.join(' '), evidenceUrl: 'https://loteria.example/x.pdf' };

describe('admin Quiniela draw', () => {
	it('offers the draw form for quiniela prizes while awarding, and keeps manual prizes on their editor', () => {
		const body = html(AwardsPage, { data: { board: board() }, form: null });
		const page = text(body);
		expect(page).toContain('Sorteo de la Quiniela');
		expect(body).toMatch(/name="extracts"/);
		expect(body).toMatch(/name="evidenceUrl"/);
		expect(body).toMatch(/name="drawTime"[^>]*type="time"|type="time"[^>]*name="drawTime"/);
		expect(page).toContain('Hora oficial del sorteo');
		expect(body).toMatch(/action="\?\/quinielaPreview"/);
		expect(page).toContain('Se define con el sorteo de la Quiniela');
		// No confirmation without a preview.
		expect(body).not.toMatch(/action="\?\/quinielaConfirm"/);
	});

	it('previews each extract, the winners and alternates per unit and the vacant units, then offers to confirm the same data', () => {
		const body = html(AwardsPage, { data: { board: board() }, form: { target: 'quiniela', ok: true, message: 'Revisá el resultado antes de confirmarlo', preview, input } });
		const page = text(body);
		expect(page).toContain('1.º 9999 Sin coincidencia');
		expect(page).toContain('2.º 0000 N.º 0000 Ganador: Moto, unidad 1');
		expect(page).toContain('3.º 0000 Repetido, no cuenta');
		expect(page).toContain('4.º 0005 Ya figura en otro premio');
		expect(page).toContain('6.º 0007 N.º 0007 Suplente 1: Moto, unidad 1');
		expect(page).toContain('Moto, unidad 1 Ganador N.º 0000 (extracto 2.º) Suplente 1 N.º 0007 (extracto 6.º)');
		expect(page).toContain('$100.000, unidad 2 Vacante');
		expect(body).toMatch(/action="\?\/quinielaConfirm"/);
		// The confirmation sends exactly what was previewed.
		expect(body).toMatch(new RegExp(`type="hidden" name="extracts" value="${input.extracts}"`));
		expect(body).toMatch(/type="hidden" name="drawDate" value="2026-11-29"/);
		expect(body).toMatch(/type="hidden" name="drawTime" value="21:00"/);
		// Confirming sends back the preview digest: the API refuses it if the result changed.
		expect(body).toMatch(new RegExp(`type="hidden" name="digest" value="${'d'.repeat(64)}"`));
	});

	it('shows a recorded draw instead of the form', () => {
		const recorded = board({ quinielaDraw: { round: 1, source: 'Quiniela de la Ciudad, Nocturna', drawnAt: '2026-11-30T00:00:00.000Z', extracts, evidenceUrl: 'https://loteria.example/x.pdf', recordedAt: '2026-11-30T12:00:00Z' } });
		const body = html(AwardsPage, { data: { board: recorded }, form: null });
		const page = text(body);
		expect(page).toContain('Quiniela de la Ciudad, Nocturna, sorteo del 29/11/2026 a las 21:00');
		expect(page).toContain('1.º 9999');
		expect(page).toContain('20.º 1013');
		expect(body).not.toMatch(/action="\?\/quinielaPreview"/);
	});
});

describe('transparency page with a Quiniela draw', () => {
	const transparency = {
		slug: 'moto',
		title: 'Moto',
		status: 'awarding',
		isDemo: false,
		closesAt: '2026-11-28T23:00:00Z',
		drawAt: null,
		streamUrl: null,
		replayUrl: null,
		entryDigits: 4,
		totals: { eligibleEntries: 8, participants: 4, voidedEntries: 0 },
		ruleVersions: [],
		round: 1,
		manifest: null,
		manifests: [],
		timeline: [],
		quinielaDraws: [{ round: 1, source: 'Quiniela de la Ciudad, Nocturna', drawnAt: '2026-11-30T00:00:00.000Z', extracts, evidenceUrl: 'https://loteria.example/x.pdf', recordedAt: '2026-11-30T12:00:00Z' }],
		awards: [
			{ prize: 'Moto', slot: 1, role: 'winner', status: 'pending_verification', entryNumber: 0, extractPosition: 2, fulfillment: null },
			{ prize: 'Kit', slot: 1, role: 'winner', status: 'pending_verification', entryNumber: 5, extractPosition: null, fulfillment: null }
		],
		vacantSlots: [{ prize: '$100.000', slot: 2 }]
	};

	it('lists the source, date, the 20 extracts in order and the evidence, then each winner with its extract and the vacant units', () => {
		const body = html(TransparencyPage, { data: { transparency } });
		const page = text(body);
		expect(page).toContain('Sorteo de la Quiniela');
		expect(page).toContain('Quiniela de la Ciudad, Nocturna, sorteo del 29/11/2026 a las 21:00');
		expect(page).toMatch(/1\.º 9999 2\.º 0000 3\.º 0000 4\.º 0005 .* 20\.º 1013/);
		expect(body).toContain('href="https://loteria.example/x.pdf"');
		expect(page).toContain('Moto Cupón N.º 0000 Ganador extracto 2.º');
		expect(page).not.toMatch(/Kit Cupón N\.º 0005 Ganador extracto/);
		expect(page).toContain('$100.000, unidad 2 Vacante');
	});

	it('keeps the page as before for a campaign without a draw', () => {
		const page = text(html(TransparencyPage, { data: { transparency: { ...transparency, quinielaDraws: [], vacantSlots: [] } } }));
		expect(page).not.toContain('Sorteo de la Quiniela');
		expect(page).not.toContain('Vacante');
	});
});

describe('prize editor (ADR 0014 §2)', () => {
	const prize = (id: string, mechanism: 'quiniela' | 'manual') => ({
		id,
		position: 1,
		kind: 'vehicle',
		title: 'Moto',
		description: null,
		declaredValueMinor: 100,
		quantity: 1,
		alternatesCount: 2,
		mechanism,
		conditions: null,
		imageUrl: null,
		video: null
	});
	const campaign = {
		id: 'c1',
		productIds: [],
		products: [],
		slug: 'moto',
		title: 'Moto',
		subtitle: null,
		summary: 'S',
		status: 'draft',
		isDemo: false,
		timezone,
		opensAt: '2026-10-20T00:00:00Z',
		closesAt: '2026-11-28T23:00:00Z',
		drawAt: null,
		streamUrl: null,
		replayUrl: null,
		video: null,
		requiredApprovals: [],
		gate: { allowed: false, missing: [], rejected: [] },
		allowedTransitions: [],
		canClose: false,
		approvals: [],
		rules: [],
		chanceVariants: [],
		prizes: [],
		events: [],
		manifest: null,
		totals: { eligibleEntries: 0, participants: 0 }
	};
	const editor = (editable: boolean) =>
		html(CampaignAdminPage, {
			data: {
				campaign,
				prizeEditor: { prizes: [prize('p1', 'quiniela'), prize('p2', 'manual')], editable, videoEditable: false, videos: [] },
				session: { organization: { currency: 'ARS' }, permissions: ['campaigns.manage'] }
			},
			form: null
		});

	it('chooses how each prize is decided while prizes are editable, and says it in the list', () => {
		const body = editor(true);
		expect(body).toMatch(/<select id="pmech-p1" name="mechanism">[\s\S]*?<option value="quiniela" selected[^>]*>Sorteo de la Quiniela \(20 extractos\)<\/option>/);
		expect(body).toMatch(/<select id="pmech-p2" name="mechanism">[\s\S]*?<option value="manual" selected[^>]*>Carga manual del resultado<\/option>/);
		// New prizes start manual.
		expect(body).toMatch(/<select id="pmech-new" name="mechanism">[\s\S]*?<option value="manual" selected/);
		expect(text(body)).toContain('Vehículo, 2 suplente(s) por unidad, sorteo de la Quiniela');
	});

	it('shows no editor once prizes are fixed', () => {
		expect(editor(false)).not.toMatch(/name="mechanism"/);
	});
});
