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

const page = (featured: CampaignSummary | null) =>
	render(ShopPage, {
		props: { data: { products, chances: null, unavailable: false, featured, serverTime: '2026-11-15T12:00:00.000Z', example: null, site }, form: null } as never
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
	});

	it('keeps the plain "Tienda" heading and no campaign block when no campaign is featured', () => {
		const html = page(null);
		expect([...html.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/g)].map((match) => text(match[1]!))).toEqual(['Tienda']);
		expect(text(html)).not.toMatch(/Participaciones por|Premios|Transparencia y bases/);
		expect(text(html)).toContain('Manual Taller Demo');
	});
});
