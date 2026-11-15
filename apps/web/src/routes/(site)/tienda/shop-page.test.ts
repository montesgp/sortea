import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';
import type { CampaignSummary, Product } from '#lib/server/types.js';
import ShopPage from './+page.svelte';

// Owner feedback 2026-11-15 (S1): the shop is the page linked from social media,
// where the campaign is already explained. With a campaign it opens with one
// plain heading, "Participaciones por <campaign>", and the products right after
// it; the campaign data (dates, countdown, prizes, transparency) goes after the
// last product.

vi.mock('$app/forms', () => ({ enhance: () => ({ destroy() {} }) }));

const text = (html: string) => html.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

const product = (id: string, name: string): Product => ({
	id,
	slug: id,
	name,
	description: 'Digital.',
	kind: 'digital',
	imageUrl: null,
	variants: [{ id: `${id}-v`, name: 'Única', priceMinor: 500_000, currency: 'ARS', inStock: true, maxPerOrder: 5 }],
	upsells: []
});
const campaign: CampaignSummary = {
	slug: 'moto',
	title: 'Moto 0 km',
	subtitle: null,
	summary: 'Cada compra suma chances.',
	status: 'open',
	isDemo: false,
	opensAt: '2026-11-01T12:00:00.000Z',
	closesAt: '2026-12-01T12:00:00.000Z',
	drawAt: '2026-12-02T23:00:00.000Z',
	video: null,
	mainPrize: 'Moto 0 km',
	prizeCount: 1,
	prizes: [{ position: 1, kind: 'physical', title: 'Moto 0 km', quantity: 1, imageUrl: null, video: null }]
};
const site = { organization: { name: 'Taller Demo', timezone: 'America/Argentina/Buenos_Aires' } };
const products = [product('manual', 'Manual Taller Demo'), product('checklist', 'Checklist Taller Demo')];

const chances = { campaign: { slug: 'moto', title: 'Moto 0 km' }, perUnit: {}, maxPerIdentity: null };
const page = (featured: CampaignSummary | null, openChances: typeof chances | null = featured?.status === 'open' ? chances : null) =>
	render(ShopPage, {
		props: { data: { products, chances: openChances, unavailable: false, featured, serverTime: '2026-11-15T12:00:00.000Z', example: null, site }, form: null } as never
	}).body;

describe('shop page (S1)', () => {
	it('opens with "Participaciones por <campaign>" and the products, and puts the campaign after the last product', () => {
		const html = page(campaign);
		const headings = [...html.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/g)].map((match) => text(match[1]!));
		expect(headings).toEqual(['Participaciones por Moto 0 km']);

		const body = text(html);
		const firstProduct = body.indexOf('Manual Taller Demo');
		const lastProduct = body.lastIndexOf('Checklist Taller Demo');
		expect(body.indexOf('Participaciones por Moto 0 km')).toBeLessThan(firstProduct);
		// Nothing about the campaign comes before the products.
		for (const campaignData of ['Apertura', 'Cierre', 'Premios', 'Transparencia y bases']) {
			expect(body.indexOf(campaignData), campaignData).toBeGreaterThan(lastProduct);
		}
		// The band no longer points down to the products it now follows.
		expect(body).not.toContain('Ver los productos');
		expect(html).toContain('href="/sorteos/moto"');
		// Its transparency page then goes back to the shop (S4).
		expect(html).toContain('href="/sorteos/moto/transparencia?desde=tienda"');
	});

	// Owner feedback 2026-11-15 S2: the heading invites to buy and play, with the campaign's status pill.
	it('shows the status pill and an invitation to take part above the products while the campaign is open', () => {
		const html = page(campaign);
		const body = text(html);
		const firstProduct = body.indexOf('Manual Taller Demo');
		const pill = body.indexOf('Participaciones abiertas');
		expect(pill).toBeGreaterThanOrEqual(0);
		expect(pill).toBeLessThan(body.indexOf('Participaciones por Moto 0 km'));
		expect(html).toMatch(/class="[^"]*chip ok[^"]*live/);
		const invitation = body.indexOf('Cada compra te suma chances para ganar. Elegí tu producto y participá.');
		expect(invitation).toBeGreaterThan(pill);
		expect(invitation).toBeLessThan(firstProduct);
	});

	it('shows the status of a campaign that does not accept participations yet, without the invitation', () => {
		const body = text(page({ ...campaign, status: 'published' }));
		expect(body.indexOf('Próximamente')).toBeLessThan(body.indexOf('Participaciones por Moto 0 km'));
		expect(body).not.toContain('Participaciones abiertas');
		expect(body).not.toContain('Cada compra te suma chances');
	});

	it('makes no promise of chances once the coupons ran out', () => {
		// The API sends no chances then (ADR 0014 §1); the campaign is still open.
		const body = text(page(campaign, null));
		expect(body).toContain('Participaciones abiertas');
		expect(body).not.toContain('Cada compra te suma chances');
	});

	it('keeps the plain "Tienda" heading and no campaign block when no campaign is featured', () => {
		const html = page(null);
		expect([...html.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/g)].map((match) => text(match[1]!))).toEqual(['Tienda']);
		expect(text(html)).not.toMatch(/Participaciones por|Premios|Transparencia y bases/);
		expect(text(html)).toContain('Manual Taller Demo');
	});
});

// Owner feedback 2026-11-15c S2: the shop carries the whole campaign page after its products
// (gallery, facts, prizes, FAQs, authorizations, bases), and its call to act points up to them.
describe('shop page with the campaign content (2026-11-15c S2)', () => {
	const detail = {
		slug: 'moto',
		title: 'Moto 0 km',
		subtitle: null,
		summary: 'Cada compra suma chances.',
		status: 'open',
		isDemo: false,
		timezone: 'America/Argentina/Buenos_Aires',
		opensAt: '2026-11-01T12:00:00.000Z',
		closesAt: '2026-12-01T12:00:00.000Z',
		drawAt: null,
		streamUrl: null,
		replayUrl: null,
		video: null,
		productIds: [],
		modality: null,
		authority: null,
		seo: {},
		acceptingParticipations: true,
		round: 1,
		carriedOver: [],
		compliance: { allowed: true, demo: false, approvals: [] },
		rules: { version: 1, status: 'locked', lockedAt: '2026-11-01T12:00:00.000Z', contentHash: 'abcdef0123456789abcdef', body: '' },
		qualifyingVariants: [],
		chancesPerUnit: {},
		maxChancesPerIdentity: null,
		entryDigits: 4,
		couponsRemaining: 10,
		soldOut: false,
		prizes: [
			{
				position: 1,
				kind: 'vehicle',
				title: 'Moto 0 km',
				description: 'Original, única dueña.',
				declaredValueMinor: 0,
				currency: 'ARS',
				quantity: 1,
				conditions: null,
				imageUrl: '/tenants/demo/premios/moto.jpg',
				video: null,
				gallery: [{ kind: 'image', url: '/tenants/demo/premios/moto-lateral.jpg', alt: 'La moto de costado' }]
			}
		],
		media: [],
		faqs: [{ question: '¿Cómo participo?', answer: 'Comprando un producto.' }],
		winners: null,
		serverTime: '2026-11-15T12:00:00.000Z'
	};
	const shop = (campaignDetail: typeof detail | null) =>
		render(ShopPage, {
			props: {
				data: {
					products,
					chances,
					unavailable: false,
					featured: campaign,
					campaign: campaignDetail,
					rulesHtml: '<p>Bases completas.</p>',
					origin: 'https://taller.example',
					serverTime: '2026-11-15T12:00:00.000Z',
					example: null,
					site
				},
				form: null
			} as never
		});

	it('shows the campaign page content after the last product, with one page heading', () => {
		const { body: html } = shop(detail);
		const body = text(html);
		const lastProduct = body.lastIndexOf('Checklist Taller Demo');
		for (const content of ['Apertura', 'Cierre', 'Premios', 'Original, única dueña.', 'Preguntas frecuentes', '¿Cómo participo?', 'Autorizaciones', 'Bases y condiciones', 'Leer las bases y condiciones', 'Transparencia y bases']) {
			expect(body.indexOf(content), content).toBeGreaterThan(lastProduct);
		}
		expect(html).toContain('alt="La moto de costado"');
		expect(html).toContain('Bases completas.');
		expect([...html.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/g)].map((match) => text(match[1]!))).toEqual(['Participaciones por Moto 0 km']);
		expect([...html.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/g)].map((match) => text(match[1]!))).toContain('Moto 0 km');
		expect(html).toContain('href="/sorteos/moto/transparencia?desde=tienda"');
		// The products are above: the campaign content does not repeat them.
		expect(body.indexOf('Manual Taller Demo')).toBe(body.lastIndexOf('Manual Taller Demo'));
	});

	it('points the call to act up to the products', () => {
		const html = shop(detail).body;
		const cta = html.match(/<a class="button" href="#productos"[^>]*>([\s\S]*?)<\/a>/);
		expect(cta).not.toBeNull();
		expect(text(cta![1]!)).toBe('↑ Elegir producto y participar');
		expect(html).toContain('id="productos"');
	});

	it('shares the shop with the main prize photo (S1)', () => {
		const { head } = shop(detail);
		expect(head).toContain('<meta property="og:image" content="https://taller.example/tenants/demo/premios/moto.jpg"');
		expect(head).toContain('<meta property="og:url" content="https://taller.example/tienda"');
		expect(head).toContain('<meta name="twitter:card" content="summary_large_image"');
	});

	it('falls back to the campaign band when the campaign detail is unavailable', () => {
		const body = text(shop(null).body);
		expect(body).toContain('Transparencia y bases');
		expect(body).not.toContain('Preguntas frecuentes');
	});
});
