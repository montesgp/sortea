import { describe, expect, it } from 'vitest';
import {
	checkLegalVersion,
	cmsBlockKeys,
	collectMediaRefs,
	faqInputSchema,
	MEDIA_MAX_BYTES,
	mediaStoragePath,
	parseCmsBlock,
	resolveMediaRefs,
	sniffImage,
	youtubeVideoId
} from '../src';

const org = '6f1c2a5e-0b8d-4e7a-9c3f-2d1e0a9b8c7d';
const sha = 'a'.repeat(64);

describe('CMS blocks', () => {
	it('knows every editable block', () => {
		expect(cmsBlockKeys).toEqual(['brand', 'home', 'seo', 'announcement', 'legal.terms', 'legal.privacy']);
	});

	it('accepts the home content seeded for both demo organizations', () => {
		const garage = {
			heroStyle: 'garage',
			processStyle: 'pistons',
			heroTitle: 'Acá las motos vuelven a arrancar',
			heroLead: 'Taller, restauraciones, clásicas y coleccionables.',
			heroImage: '/tenants/motogarage/taller.jpg',
			heroImageAlt: 'Honda CRF supermotard',
			servicesTitle: 'Lo que pasa en el garage',
			services: [{ title: 'Taller', body: 'Diagnóstico y mantenimiento.' }],
			processTitle: 'Así encaramos una restauración',
			process: [{ title: 'Desarme', body: 'Fotos, inventario y diagnóstico.' }],
			ctaTitle: 'Seguinos en Instagram',
			ctaBody: 'Ahí mostramos los trabajos del taller.'
		};
		expect(parseCmsBlock('home', garage).success).toBe(true);

		const plain = parseCmsBlock('home', { heroTitle: 'Pista Sur', heroLead: 'Segundo tenant.', heroImage: null, services: [], process: [], ctaTitle: 'Demo', ctaBody: 'Demo.' });
		expect(plain.success).toBe(true);
		expect(plain.success && plain.data).toMatchObject({ heroStyle: 'simple', processStyle: 'list', heroVideoUrl: null });
	});

	it('rejects unknown keys, unsafe links and oversized lists', () => {
		expect(parseCmsBlock('footer' as never, {}).success).toBe(false);
		expect(parseCmsBlock('brand', { logo: 'http://evil.test/logo.png', logoAlt: 'x', tagline: 'x' }).success).toBe(false);
		expect(parseCmsBlock('brand', { logo: 'javascript:alert(1)', logoAlt: 'x', tagline: 'x' }).success).toBe(false);
		const service = { title: 'Taller', body: 'Mantenimiento.' };
		expect(parseCmsBlock('home', { heroTitle: 'Hola', heroLead: 'Lead', services: Array(9).fill(service), process: [] }).success).toBe(false);
		expect(parseCmsBlock('announcement', { enabled: true, text: 'Abrió la campaña', linkUrl: 'javascript:alert(1)', linkLabel: 'Ver' }).success).toBe(false);
		expect(parseCmsBlock('announcement', { enabled: true, text: 'Abrió la campaña', linkUrl: '//evil.test/x', linkLabel: 'Ver' }).success).toBe(false);
		expect(parseCmsBlock('announcement', { enabled: true, text: 'Abrió la campaña', linkUrl: '/sorteos/moto', linkLabel: 'Ver' }).success).toBe(true);
	});

	it('only accepts YouTube links as videos', () => {
		const home = { heroTitle: 'Hola', heroLead: 'Lead', services: [], process: [] };
		expect(parseCmsBlock('home', { ...home, heroVideoUrl: 'https://youtu.be/dQw4w9WgXcQ' }).success).toBe(true);
		expect(parseCmsBlock('home', { ...home, heroVideoUrl: 'https://vimeo.com/123456' }).success).toBe(false);
		expect(youtubeVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
		expect(youtubeVideoId('https://www.youtube.com/live/dQw4w9WgXcQ?si=x')).toBe('dQw4w9WgXcQ');
		expect(youtubeVideoId('http://youtube.com/watch?v=dQw4w9WgXcQ')).toBeNull();
		expect(youtubeVideoId('https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ')).toBeNull();
	});

	it('requires SEO text within search engine limits', () => {
		expect(parseCmsBlock('seo', { title: 'MotoGarage', description: 'Taller en Arrecifes', image: null }).success).toBe(true);
		expect(parseCmsBlock('seo', { title: 'x'.repeat(71), description: 'Taller', image: null }).success).toBe(false);
		expect(parseCmsBlock('seo', { title: 'MotoGarage', description: 'x'.repeat(201), image: null }).success).toBe(false);
	});

	it('requires legal texts to carry a version and at least one section', () => {
		const doc = { version: '2026-10', sections: [{ title: 'Compra', body: 'La compra se confirma cuando el pago se aprueba.' }] };
		expect(parseCmsBlock('legal.terms', doc).success).toBe(true);
		expect(parseCmsBlock('legal.terms', { ...doc, sections: [] }).success).toBe(false);
		expect(parseCmsBlock('legal.privacy', { ...doc, version: 'versión 1' }).success).toBe(false);
	});
});

describe('legal versions', () => {
	it('publishes a legal text only under a new version, so consents keep meaning what was shown', () => {
		expect(checkLegalVersion(null, '2026-10')).toEqual({ ok: true });
		expect(checkLegalVersion('2026-10', '2026-11')).toEqual({ ok: true });
		expect(checkLegalVersion('2026-10', '2026-10')).toEqual({ ok: false, reason: 'version_unchanged' });
		expect(checkLegalVersion(null, 'pending')).toEqual({ ok: false, reason: 'version_reserved' });
	});

	it('never reuses an earlier version for different text, but lets the same text come back', () => {
		expect(checkLegalVersion('2026-11', '2026-10', { usedForOtherText: true })).toEqual({ ok: false, reason: 'version_used' });
		expect(checkLegalVersion('2026-11', '2026-10', { usedForOtherText: false })).toEqual({ ok: true });
	});
});

describe('media', () => {
	const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
	const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
	const webp = new Uint8Array([...'RIFF'].map((c) => c.charCodeAt(0)).concat([0, 0, 0, 0], [...'WEBP'].map((c) => c.charCodeAt(0))));
	const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

	it('recognizes images by their bytes, not by the declared type', () => {
		expect(sniffImage(jpeg)).toEqual({ contentType: 'image/jpeg', extension: 'jpg' });
		expect(sniffImage(png)).toEqual({ contentType: 'image/png', extension: 'png' });
		expect(sniffImage(webp)).toEqual({ contentType: 'image/webp', extension: 'webp' });
		expect(sniffImage(svg)).toBeNull();
		expect(sniffImage(new Uint8Array([0x25, 0x50, 0x44, 0x46]))).toBeNull();
		expect(sniffImage(new Uint8Array())).toBeNull();
	});

	it('caps uploads at 2 MB', () => {
		expect(MEDIA_MAX_BYTES).toBe(2 * 1024 * 1024);
	});

	it('stores media under the organization, addressed by content', () => {
		expect(mediaStoragePath(org, sha, 'jpg')).toBe(`${org}/${sha}.jpg`);
		expect(() => mediaStoragePath('../other', sha, 'jpg')).toThrow();
		expect(() => mediaStoragePath(org, 'abc', 'jpg')).toThrow();
	});

	it('finds and resolves media references anywhere in a block', () => {
		const ref = `media:${org}/${sha}.webp`;
		const content = { logo: ref, nested: [{ image: ref }, { image: '/tenants/x.jpg' }], text: 'media: no es una referencia' };
		expect(parseCmsBlock('brand', { logo: ref, logoAlt: 'Logo', tagline: 'Hola' }).success).toBe(true);
		expect(parseCmsBlock('brand', { logo: `media:${org}/../x.webp`, logoAlt: 'Logo', tagline: 'Hola' }).success).toBe(false);
		expect(collectMediaRefs(content)).toEqual([`${org}/${sha}.webp`]);
		expect(resolveMediaRefs(content, (path) => `https://cdn.test/${path}`)).toEqual({
			logo: `https://cdn.test/${org}/${sha}.webp`,
			nested: [{ image: `https://cdn.test/${org}/${sha}.webp` }, { image: '/tenants/x.jpg' }],
			text: 'media: no es una referencia'
		});
	});
});

describe('FAQs', () => {
	it('validates question and answer', () => {
		expect(faqInputSchema.safeParse({ question: '¿Cómo participo?', answer: 'Comprando un producto de la tienda.' }).success).toBe(true);
		expect(faqInputSchema.safeParse({ question: '¿?', answer: 'Comprando un producto.' }).success).toBe(false);
		expect(faqInputSchema.safeParse({ question: '¿Cómo participo?', answer: 'x'.repeat(2001) }).success).toBe(false);
	});
});
