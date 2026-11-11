import { describe, expect, it } from 'vitest';
import { acceptsParticipations, campaignCreateSchema, campaignScheduleIssues, canTransition, evaluateComplianceGate, type CampaignTransitionContext } from '../src';

/** A campaign created from the admin can wait for its dates as a draft (S5, owner feedback 2026-11-10). */

const gate = evaluateComplianceGate(['legal', 'psp'], [
	{ kind: 'legal', status: 'approved', reference: 'REF-legal', decidedAt: new Date('2026-10-01T00:00:00Z') },
	{ kind: 'psp', status: 'approved', reference: 'REF-psp', decidedAt: new Date('2026-10-01T00:00:00Z') }
]);
const undated: CampaignTransitionContext = {
	gate,
	hasLockedRuleVersion: true,
	prizeCount: 3,
	opensAt: null,
	closesAt: null,
	now: new Date('2026-11-10T12:00:00Z'),
	hasPublishedManifest: false
};

describe('a campaign without dates', () => {
	it('moves between draft and review, and can be archived', () => {
		expect(canTransition('draft', 'review', undated)).toEqual({ ok: true });
		expect(canTransition('review', 'draft', undated)).toEqual({ ok: true });
		expect(canTransition('draft', 'archived', undated)).toEqual({ ok: true });
	});

	it('is neither published nor opened until it has an opening and a closing', () => {
		expect(canTransition('review', 'published', undated)).toEqual({ ok: false, reason: 'missing_schedule' });
		expect(canTransition('published', 'open', undated)).toEqual({ ok: false, reason: 'missing_schedule' });
		expect(canTransition('published', 'open', { ...undated, opensAt: new Date('2026-11-20T00:00:00Z') })).toEqual({ ok: false, reason: 'missing_schedule' });
	});

	it('accepts no participations', () => {
		expect(acceptsParticipations('open', gate, { opensAt: null, closesAt: null }, new Date('2026-11-10T12:00:00Z'))).toBe(false);
	});
});

describe('campaign schedule', () => {
	const at = (iso: string) => new Date(iso);

	it('has nothing to say about missing dates', () => {
		expect(campaignScheduleIssues({ opensAt: null, closesAt: null, drawAt: null })).toEqual([]);
		expect(campaignScheduleIssues({ opensAt: at('2026-12-01T00:00:00Z'), closesAt: null, drawAt: null })).toEqual([]);
	});

	it('wants the closing after the opening', () => {
		expect(campaignScheduleIssues({ opensAt: at('2026-12-01T00:00:00Z'), closesAt: at('2026-12-01T00:00:00Z'), drawAt: null })).toEqual([
			{ field: 'closesAt', message: 'El cierre tiene que ser posterior a la apertura' }
		]);
	});

	it('wants the draw after the closing, or after the opening while there is no closing', () => {
		expect(campaignScheduleIssues({ opensAt: at('2026-12-01T00:00:00Z'), closesAt: at('2026-12-20T00:00:00Z'), drawAt: at('2026-12-19T00:00:00Z') })).toEqual([
			{ field: 'drawAt', message: 'El sorteo tiene que ser posterior al cierre' }
		]);
		expect(campaignScheduleIssues({ opensAt: at('2026-12-01T00:00:00Z'), closesAt: null, drawAt: at('2026-11-30T00:00:00Z') })).toEqual([
			{ field: 'drawAt', message: 'El sorteo tiene que ser posterior a la apertura' }
		]);
		expect(campaignScheduleIssues({ opensAt: at('2026-12-01T00:00:00Z'), closesAt: at('2026-12-20T00:00:00Z'), drawAt: at('2026-12-21T00:00:00Z') })).toEqual([]);
	});
});

describe('new campaign input', () => {
	const valid = {
		title: 'Honda Wave 0 km',
		slug: 'honda-wave',
		summary: 'Sorteamos una Honda Wave 0 km entre quienes compran en la tienda.',
		rulesMarkdown: '# Bases\n\nTexto inicial de las bases y condiciones.'
	};

	it('fills in the defaults of a draft without dates', () => {
		const parsed = campaignCreateSchema.parse(valid);
		expect(parsed.timezone).toBeUndefined();
		expect(parsed).toMatchObject({
			subtitle: null,
			opensAt: null,
			closesAt: null,
			drawAt: null,
			seo: {},
			eligibility: { minAge: 18, residency: 'República Argentina' },
			chancesPerProduct: {}
		});
	});

	it('takes empty date fields as no date', () => {
		const parsed = campaignCreateSchema.parse({ ...valid, opensAt: '', closesAt: '', drawAt: '' });
		expect([parsed.opensAt, parsed.closesAt, parsed.drawAt]).toEqual([null, null, null]);
	});

	it('reports each wrong field in Spanish', () => {
		const result = campaignCreateSchema.safeParse({
			...valid,
			title: 'H',
			slug: 'Honda Wave',
			summary: 'corto',
			timezone: 'Marte/Olympus',
			rulesMarkdown: 'Bases',
			opensAt: '2026-12-10T00:00:00Z',
			closesAt: '2026-12-01T00:00:00Z'
		});
		expect(result.success).toBe(false);
		const fields = result.success ? {} : Object.fromEntries(result.error.issues.map((issue) => [issue.path.join('.'), issue.message]));
		expect(fields).toEqual({
			title: 'Escribí un título de al menos 3 caracteres',
			slug: 'Usá minúsculas, números y guiones',
			summary: 'Escribí un resumen de al menos 10 caracteres',
			timezone: 'Elegí una zona horaria válida',
			rulesMarkdown: 'Las bases necesitan al menos 20 caracteres',
			closesAt: 'El cierre tiene que ser posterior a la apertura'
		});
	});

	it('refuses chances outside 0 to 100', () => {
		const result = campaignCreateSchema.safeParse({ ...valid, chancesPerProduct: { '7f2a6f4e-2f41-4c8e-9a51-0d3c2b1a9e10': 101 } });
		expect(result.success).toBe(false);
	});

	it('explains wrong chances and unknown products in Spanish', () => {
		const messages = (chancesPerProduct: Record<string, unknown>) => {
			const result = campaignCreateSchema.safeParse({ ...valid, chancesPerProduct });
			return result.success ? [] : result.error.issues.map((issue) => [issue.path[0], issue.message]);
		};
		const chances = 'Las chances por unidad son un número entero de 0 a 100';
		expect(messages({ '7f2a6f4e-2f41-4c8e-9a51-0d3c2b1a9e10': -1 })).toEqual([['chancesPerProduct', chances]]);
		expect(messages({ '7f2a6f4e-2f41-4c8e-9a51-0d3c2b1a9e10': 1.5 })).toEqual([['chancesPerProduct', chances]]);
		expect(messages({ '7f2a6f4e-2f41-4c8e-9a51-0d3c2b1a9e10': 'dos' })).toEqual([['chancesPerProduct', chances]]);
		expect(messages({ 'no-es-un-producto': 1 })).toEqual([['chancesPerProduct', 'Elegí productos de tu catálogo']]);
	});
});
