import type { Component } from 'svelte';
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import CampaignPage from '../../routes/(campaign)/sorteos/[slug]/+page.svelte';
import TransparencyPage from '../../routes/(campaign)/sorteos/[slug]/transparencia/+page.svelte';
import CartPage from '../../routes/(site)/carrito/+page.svelte';
import ResultPage from '../../routes/(site)/checkout/resultado/+page.svelte';
import LookupPage from '../../routes/(site)/consulta/+page.svelte';
import AwardsPage from '../../routes/admin/(app)/campanas/[id]/premios/+page.svelte';
import OrderPage from '../../routes/admin/(app)/pedidos/[id]/+page.svelte';

// ADR 0014 §1: every coupon is shown zero-padded to its campaign's digits
// ("N.º 0042"), the cart warns before paying when the pool cannot hold the
// cart, and a sold-out campaign says so instead of promising chances.

const text = (html: string) =>
	html
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/<[^>]+>/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
const page = (component: Component<never>, props: Record<string, unknown>) => text(render(component as Component, { props: props as never }).body);
const timezone = 'America/Argentina/Buenos_Aires';

describe('padded coupons on every surface', () => {
	it('checkout result page', () => {
		const order = { reference: 'TT-1', status: 'paid', totalMinor: 100, currency: 'ARS', email: 'ju***@example.com', items: [], entries: [0, 42], entryDigits: 4 };
		expect(page(ResultPage, { data: { order, accessCode: 'X' } })).toContain('Tus chances (2): N.º 0000, N.º 0042');
	});

	it('/consulta', () => {
		const result = {
			holder: { firstName: 'Juana', scope: 'contact' },
			orders: [],
			campaigns: [{ slug: 'moto', title: 'Moto', status: 'open', entryDigits: 4, entries: [{ number: 7, status: 'eligible' }] }]
		};
		expect(page(LookupPage, { data: { result }, form: null })).toContain('N.º 0007');
	});

	it('transparency page', () => {
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
			totals: { eligibleEntries: 1, participants: 1, voidedEntries: 0 },
			ruleVersions: [],
			manifest: null,
			timeline: [],
			quinielaDraws: [],
			awards: [{ prize: 'Moto', slot: 1, role: 'winner', status: 'accepted', entryNumber: 42, extractPosition: null, fulfillment: null }],
			vacantSlots: []
		};
		expect(page(TransparencyPage, { data: { transparency } })).toContain('Cupón N.º 0042');
	});

	it('admin order detail', () => {
		const order = {
			id: 'o1',
			reference: 'TT-1',
			status: 'paid',
			currency: 'ARS',
			subtotalMinor: 100,
			deliveryFeeMinor: 0,
			totalMinor: 100,
			deliveryMethod: 'digital',
			createdAt: '2026-10-25T15:00:00Z',
			paidAt: '2026-10-25T15:01:00Z',
			piiVisible: false,
			buyer: { firstName: 'Juana', lastName: 'P.', email: 'ju***@example.com', phone: null, province: null, city: null, document: null, address: null },
			items: [],
			payments: [],
			entries: [
				{ number: 0, status: 'eligible' },
				{ number: 9, status: 'void' }
			],
			entryDigits: 4,
			consents: []
		};
		expect(page(OrderPage, { data: { order, session: { organization: { timezone } } } })).toContain('N.º 0000, N.º 0009 (anulada)');
	});

	it('admin awards listing and inputs', () => {
		const award = {
			id: 'a1',
			role: 'winner',
			rank: 1,
			status: 'pending_verification',
			entryNumber: 42,
			entryVoidedAfterClose: false,
			active: true,
			notes: null,
			decidedAt: null,
			holder: null,
			fulfillment: null
		};
		const board = {
			campaign: { id: 'c1', title: 'Moto', status: 'awarding', timezone, entryDigits: 4 },
			mechanismRecorded: true,
			resultsPublished: false,
			canOperate: true,
			piiVisible: false,
			prizes: [{ id: 'p1', position: 1, kind: 'vehicle', title: 'Moto', quantity: 1, alternatesCount: 0, slots: [{ slot: 1, state: 'pending', canRecord: true, awards: [award] }] }]
		};
		const { body } = render(AwardsPage, { props: { data: { board }, form: null } as never });
		expect(text(body)).toContain('N.º 0042');
		expect(body).toMatch(/name="winner"[^>]*value="0042"/);
	});
});

describe('coupon pool in the cart and on the campaign page', () => {
	const cart = (total: number, remaining: number) =>
		page(CartPage, {
			data: {
				empty: false,
				quote: {
					ok: true,
					currency: 'ARS',
					lines: [{ variantId: 'm', name: 'Manual', kind: 'digital', quantity: total, unitPriceMinor: 100, lineTotalMinor: 100 * total }],
					subtotalMinor: 100 * total,
					totalMinor: 100 * total,
					requiresDelivery: false,
					chances: { campaign: { slug: 'moto', title: 'Moto 0 km' }, lines: [{ variantId: 'm', chances: total }], total, maxPerIdentity: null, remaining }
				},
				upsells: [],
				limits: {},
				problemLines: []
			},
			form: null
		});

	it('the cart warns before paying when its chances exceed the coupons left, and does not lead to checkout', () => {
		expect(cart(3, 2)).toContain('Quedan 2 cupones para Moto 0 km y tu carrito suma 3 chances. Quitá algunos productos para continuar.');
		expect(cart(3, 2)).not.toContain('Con esta compra sumás');
		expect(cart(3, 2)).not.toContain('Continuar con la compra');
		expect(cart(3, 3)).not.toContain('cupones para');
		expect(cart(3, 3)).toContain('Continuar con la compra');
	});

	const campaign = (soldOut: boolean) => ({
		slug: 'moto',
		title: 'Moto 0 km',
		subtitle: null,
		summary: 'Campaña',
		status: 'open',
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
		acceptingParticipations: true,
		compliance: { allowed: true, demo: false, approvals: [] },
		rules: null,
		qualifyingVariants: [],
		chancesPerUnit: {},
		maxChancesPerIdentity: null,
		entryDigits: 4,
		couponsRemaining: soldOut ? 0 : 10,
		soldOut,
		prizes: [],
		media: [],
		faqs: [],
		serverTime: '2026-10-25T15:00:00Z'
	});

	it('a sold-out campaign says the coupons are sold out and offers no participation', () => {
		const soldOut = page(CampaignPage, { data: { campaign: campaign(true), products: [], chances: null, rulesHtml: null } });
		expect(soldOut).toContain('Cupones agotados');
		expect(soldOut).toContain('Se agotaron los cupones de esta campaña: ya no se pueden sumar chances.');
		expect(soldOut).not.toContain('Elegir producto y participar');
		expect(soldOut).toContain('Se agotaron los cupones: los productos que dan chances no se pueden comprar para esta campaña.');
		expect(soldOut).not.toContain('ya no suman chances');
		const open = page(CampaignPage, { data: { campaign: campaign(false), products: [], chances: null, rulesHtml: null } });
		expect(open).toContain('Elegir producto y participar');
		expect(open).not.toContain('agotaron');
	});
});
