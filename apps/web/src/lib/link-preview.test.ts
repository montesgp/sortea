import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import LinkPreview from './components/LinkPreview.svelte';
import { campaignShareImage } from './link-preview.js';

// Owner feedback 2026-11-15c S1: sharing the campaign or the shop on WhatsApp showed no photo. Both
// pages now carry og:image (absolute, as previews need), og:url, og:type and og:site_name, and
// the large-image card.

const origin = 'https://taller.example';
const prize = (imageUrl: string | null, gallery: { kind: 'image' | 'video'; url: string; alt: string }[] = []) => ({ imageUrl, gallery });

describe('campaign share image (S1)', () => {
	it('prefers the image set for sharing, then the main prize photo, then its gallery, then the hero image', () => {
		const media = [{ kind: 'image', role: 'hero', url: '/tenants/taller/hero.jpg', alt: 'Hero' }];
		expect(campaignShareImage({ seo: { image: '/media/org/seo.jpg' }, prizes: [prize('/tenants/taller/moto.jpg')], media }, origin)).toBe('https://taller.example/media/org/seo.jpg');
		expect(campaignShareImage({ seo: {}, prizes: [prize('/tenants/taller/moto.jpg')], media }, origin)).toBe('https://taller.example/tenants/taller/moto.jpg');
		const gallery = [
			{ kind: 'video' as const, url: '/tenants/taller/moto.mp4', alt: 'Video' },
			{ kind: 'image' as const, url: 'https://cdn.example/moto-lateral.jpg', alt: 'Lateral' }
		];
		expect(campaignShareImage({ seo: {}, prizes: [prize(null, gallery)], media }, origin)).toBe('https://cdn.example/moto-lateral.jpg');
		expect(campaignShareImage({ seo: {}, prizes: [prize(null)], media }, origin)).toBe('https://taller.example/tenants/taller/hero.jpg');
		expect(campaignShareImage({ seo: {}, prizes: [], media: [] }, origin)).toBeNull();
		// An empty value is no image: the next one counts.
		expect(campaignShareImage({ seo: { image: '' }, prizes: [prize('', gallery)], media }, origin)).toBe('https://cdn.example/moto-lateral.jpg');
	});
});

describe('link preview tags (S1)', () => {
	const tags = (html: string) =>
		Object.fromEntries([...html.matchAll(/<meta (?:property|name)="((?:og|twitter):[a-z_:]+)" content="([^"]*)"/g)].map((match) => [match[1], match[2]]));

	it('writes every tag a preview needs', () => {
		const html = render(LinkPreview, {
			props: { title: 'Honda Wave', description: 'Comprá y participá.', url: 'https://taller.example/sorteos/moto', image: 'https://taller.example/tenants/taller/moto.jpg', siteName: 'Taller' }
		}).head;
		expect(tags(html)).toEqual({
			'og:type': 'website',
			'og:site_name': 'Taller',
			'og:title': 'Honda Wave',
			'og:description': 'Comprá y participá.',
			'og:url': 'https://taller.example/sorteos/moto',
			'og:image': 'https://taller.example/tenants/taller/moto.jpg',
			'og:image:alt': 'Honda Wave',
			'twitter:card': 'summary_large_image'
		});
	});

	it('leaves the image tags and the large card out without an image', () => {
		const html = render(LinkPreview, { props: { title: 'Tienda', description: 'Productos.', url: 'https://taller.example/tienda', image: null, siteName: 'Taller' } }).head;
		expect(tags(html)).toEqual({ 'og:type': 'website', 'og:site_name': 'Taller', 'og:title': 'Tienda', 'og:description': 'Productos.', 'og:url': 'https://taller.example/tienda', 'twitter:card': 'summary' });
	});
});
