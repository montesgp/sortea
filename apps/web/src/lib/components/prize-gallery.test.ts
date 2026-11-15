import type { Component } from 'svelte';
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import CampaignPage from '../../routes/(campaign)/sorteos/[slug]/+page.svelte';
import PrizeGallery from './PrizeGallery.svelte';

// owner-feedback-2026-11-14 S7: the main prize's photos and videos, like a product page.

const text = (html: string) =>
	html
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/<[^>]+>/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
const html = (component: Component<never>, props: Record<string, unknown>) => render(component as Component, { props: props as never }).body;

const items = [
	{ kind: 'image', url: '/tenants/demo/premios/moto-taller.jpg', alt: 'La moto en el taller' },
	{ kind: 'video', url: '/tenants/demo/premios/moto.mp4', alt: 'Video de la moto' },
	{ kind: 'image', url: '/tenants/demo/premios/moto-lateral.jpg', alt: 'La moto de costado' }
];

describe('prize gallery', () => {
	it('shows the first photo large, with its alt text, and one labeled thumbnail per photo or video', () => {
		const body = html(PrizeGallery, { items, title: 'Moto' });
		expect(body).toMatch(/<section[^>]*aria-label="Fotos y videos de Moto"/);
		const viewer = body.slice(body.indexOf('class="stage'), body.indexOf('class="thumbs'));
		expect(viewer).toMatch(/<img[^>]*src="\/tenants\/demo\/premios\/moto-taller\.jpg"[^>]*alt="La moto en el taller"|<img[^>]*alt="La moto en el taller"[^>]*src="\/tenants\/demo\/premios\/moto-taller\.jpg"/);
		expect(text(viewer)).toContain('1 / 3');
		expect(viewer).toContain('aria-label="Anterior"');
		expect(viewer).toContain('aria-label="Siguiente"');

		const thumbs = body.slice(body.indexOf('class="thumbs'));
		const buttons = thumbs.match(/<button[^>]*>/g) ?? [];
		expect(buttons.map((button) => button.match(/aria-label="([^"]+)"/)?.[1])).toEqual([
			'Ver foto 1 de 3: La moto en el taller',
			'Ver video 2 de 3: Video de la moto',
			'Ver foto 3 de 3: La moto de costado'
		]);
		expect(buttons[0]).toContain('aria-current="true"');
		expect(buttons[1]).not.toContain('aria-current');
		// Thumbnails load lazily; the video one shows a play mark and never plays there.
		expect(thumbs.match(/<img[^>]*>/g)!.every((image) => image.includes('loading="lazy"'))).toBe(true);
		expect(thumbs).toMatch(/class="play[\s"]/);
		expect(thumbs).not.toMatch(/autoplay/);
	});

	it('plays a video in the viewer only on request, inline and with controls', () => {
		const body = html(PrizeGallery, { items: [items[1], items[0]], title: 'Moto' });
		const viewer = body.slice(body.indexOf('class="stage'), body.indexOf('class="thumbs'));
		const video = viewer.match(/<video[^>]*>/)![0];
		expect(video).toContain('src="/tenants/demo/premios/moto.mp4"');
		expect(video).toContain('controls');
		expect(video).toContain('playsinline');
		expect(video).toContain('preload="metadata"');
		expect(video).toContain('aria-label="Video de la moto"');
		expect(video).not.toContain('autoplay');
	});

	it('shows a single photo without thumbnails or arrows', () => {
		const body = html(PrizeGallery, { items: [items[0]], title: 'Moto' });
		expect(body).toContain('alt="La moto en el taller"');
		expect(body).not.toContain('class="thumbs');
		expect(body).not.toContain('aria-label="Siguiente"');
	});
});

describe('campaign page hero', () => {
	const campaign = (gallery: unknown) => ({
		slug: 'moto',
		title: 'Moto 0 km',
		subtitle: null,
		summary: 'Campaña',
		status: 'open',
		isDemo: false,
		timezone: 'America/Argentina/Buenos_Aires',
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
		prizes: [
			{ position: 1, kind: 'vehicle', title: 'Honda Wave', description: null, declaredValueMinor: 0, currency: 'ARS', quantity: 1, conditions: null, imageUrl: '/tenants/demo/premios/moto.jpg', video: null, ...(gallery === undefined ? {} : { gallery }) },
			{ position: 2, kind: 'cash', title: '$50.000', description: null, declaredValueMinor: 5_000_000, currency: 'ARS', quantity: 5, conditions: null, imageUrl: '/tenants/demo/premios/efectivo.jpg', video: null, gallery: [] }
		],
		media: [],
		faqs: [],
		serverTime: '2026-12-01T15:00:00Z'
	});
	const page = (gallery: unknown) => html(CampaignPage, { data: { campaign: campaign(gallery), products: [], chances: null, rulesHtml: null } });
	const hero = (body: string) => body.slice(body.indexOf('class="hero'), body.indexOf('id="prizes-title"'));
	const placeholder = 'La foto y el video reales del premio se publican cuando la unidad esté en el taller.';

	it('replaces the placeholder with the main prize gallery when it has photos or videos', () => {
		const body = page(items);
		expect(hero(body)).toContain('aria-label="Fotos y videos de Honda Wave"');
		expect(hero(body)).toContain('alt="La moto en el taller"');
		expect(text(body)).not.toContain(placeholder);
		// The gallery is above; the prize card does not repeat the single photo, other prizes keep theirs.
		const prizes = body.slice(body.indexOf('id="prizes-title"'));
		expect(prizes).not.toContain('src="/tenants/demo/premios/moto.jpg"');
		expect(prizes).toContain('src="/tenants/demo/premios/efectivo.jpg"');
	});

	it('keeps the placeholder while the main prize has no gallery, also from an API without the field', () => {
		for (const gallery of [[], undefined]) {
			const body = page(gallery);
			expect(text(hero(body))).toContain(placeholder);
			expect(hero(body)).not.toContain('Fotos y videos de');
			expect(body.slice(body.indexOf('id="prizes-title"'))).toContain('src="/tenants/demo/premios/moto.jpg"');
		}
	});

	// 2026-11-15c S2: the products section is drawn by the shared content, so it keeps the section styles.
	it('styles the products heading like every other section of the campaign', () => {
		const body = page(items);
		const scope = (title: string) => body.match(new RegExp(`<h2 id="${title}" class="(svelte-[a-z0-9]+)"`))?.[1];
		expect(scope('prizes-title')).toBeDefined();
		expect(scope('products-title')).toBe(scope('prizes-title'));
		expect(body).toContain('id="productos"');
	});

	// Owner feedback 2026-11-15c S1: a shared campaign link showed no photo on WhatsApp.
	it('shares the campaign link with the main prize photo as an absolute address', () => {
		const { head } = render(CampaignPage as Component, {
			props: { data: { campaign: campaign(items), products: [], chances: null, rulesHtml: null, origin: 'https://taller.example', site: { organization: { name: 'Taller Demo' } } } } as never
		});
		expect(head).toContain('<meta property="og:image" content="https://taller.example/tenants/demo/premios/moto.jpg"');
		expect(head).toContain('<meta property="og:url" content="https://taller.example/sorteos/moto"');
		expect(head).toContain('<meta property="og:site_name" content="Taller Demo"');
		expect(head).toContain('<meta name="twitter:card" content="summary_large_image"');
	});
});
