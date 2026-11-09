import { describe, expect, it } from 'vitest';
import { blockContentFromForm, contentIssue, editableRows, faqOrder, faqPositionFromForm, nextFaqOrder } from './cms-form';

function form(entries: Record<string, string>): FormData {
	const data = new FormData();
	for (const [key, value] of Object.entries(entries)) data.append(key, value);
	return data;
}

describe('block content from the editor form', () => {
	it('builds the home block, dropping empty rows and empty optional fields', () => {
		const content = blockContentFromForm(
			'home',
			form({
				heroStyle: 'garage',
				processStyle: 'list',
				heroTitle: ' Acá las motos vuelven a arrancar ',
				heroLead: 'Taller y restauraciones.',
				heroImage: 'media:abc',
				heroImageAlt: '',
				heroVideoUrl: '',
				servicesTitle: 'Servicios',
				'services.0.title': 'Taller',
				'services.0.body': 'Service completo.',
				'services.1.title': '',
				'services.1.body': '',
				'services.2.title': 'Clásicas',
				'services.2.body': 'Motos con historia.',
				processTitle: '',
				ctaTitle: 'Seguinos',
				ctaBody: ''
			})
		);
		expect(content).toEqual({
			heroStyle: 'garage',
			processStyle: 'list',
			heroTitle: 'Acá las motos vuelven a arrancar',
			heroLead: 'Taller y restauraciones.',
			heroImage: 'media:abc',
			heroImageAlt: null,
			heroVideoUrl: null,
			servicesTitle: 'Servicios',
			services: [
				{ title: 'Taller', body: 'Service completo.' },
				{ title: 'Clásicas', body: 'Motos con historia.' }
			],
			processTitle: null,
			process: [],
			ctaTitle: 'Seguinos',
			ctaBody: null,
			productIds: []
		});
	});

	it('reads the products checked for the home, none meaning every product (2026-10-18b)', () => {
		const data = form({ heroTitle: 'T', heroLead: 'L' });
		data.append('productId', '11111111-1111-4111-8111-111111111111');
		data.append('productId', '22222222-2222-4222-8222-222222222222');
		expect(blockContentFromForm('home', data)).toMatchObject({ productIds: ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'] });
	});

	it('keeps a half-filled row so the API can point at the missing field', () => {
		const content = blockContentFromForm('legal.terms', form({ version: '2026-11', 'sections.0.title': 'Compra', 'sections.0.body': '' }));
		expect(content).toEqual({ version: '2026-11', sections: [{ title: 'Compra', body: '' }] });
	});

	it('reads the banner switch and the other blocks', () => {
		expect(blockContentFromForm('announcement', form({ enabled: 'on', text: 'Abrió la campaña', linkUrl: '/sorteos/moto', linkLabel: '' }))).toEqual({
			enabled: true,
			text: 'Abrió la campaña',
			linkUrl: '/sorteos/moto',
			linkLabel: null
		});
		expect(blockContentFromForm('announcement', form({ text: 'Aviso', linkUrl: '' }))).toMatchObject({ enabled: false, linkUrl: null });
		expect(blockContentFromForm('brand', form({ logo: '', logoAlt: 'Taller Demo', tagline: 'Motos' }))).toEqual({ logo: null, logoAlt: 'Taller Demo', tagline: 'Motos' });
		expect(blockContentFromForm('seo', form({ title: 'Taller Demo', description: 'Taller', image: 'media:x' }))).toEqual({ title: 'Taller Demo', description: 'Taller', image: 'media:x' });
	});
});

describe('gallery from the editor form', () => {
	it('builds photos with their credits, dropping empty rows and empty optional fields', () => {
		const content = blockContentFromForm(
			'gallery',
			form({
				enabled: 'on',
				showInMenu: 'on',
				title: ' Restauraciones ',
				lead: '',
				note: 'Fotos de ejemplo.',
				'items.0.image': '/tenants/taller-demo/restauraciones/honda.jpg',
				'items.0.alt': 'Honda CB750 restaurada',
				'items.0.title': 'Honda CB750',
				'items.0.body': 'Cuatro cilindros.',
				'items.0.author': 'Jane Doe',
				'items.0.license': 'CC BY-SA 4.0',
				'items.0.sourceUrl': 'https://commons.wikimedia.org/wiki/File:Honda.jpg',
				'items.1.image': '',
				'items.1.alt': '',
				'items.1.title': '',
				'items.1.body': '',
				'items.1.author': '',
				'items.1.license': '',
				'items.1.sourceUrl': '',
				'items.2.image': 'media:abc',
				'items.2.alt': 'Café racer',
				'items.2.title': 'Café racer',
				'items.2.body': '',
				'items.2.author': '',
				'items.2.license': '',
				'items.2.sourceUrl': ''
			})
		);
		expect(content).toEqual({
			enabled: true,
			showOnHome: false,
			showInMenu: true,
			title: 'Restauraciones',
			lead: null,
			note: 'Fotos de ejemplo.',
			items: [
				{
					image: '/tenants/taller-demo/restauraciones/honda.jpg',
					alt: 'Honda CB750 restaurada',
					title: 'Honda CB750',
					body: 'Cuatro cilindros.',
					credit: { author: 'Jane Doe', license: 'CC BY-SA 4.0', sourceUrl: 'https://commons.wikimedia.org/wiki/File:Honda.jpg' }
				},
				{ image: 'media:abc', alt: 'Café racer', title: 'Café racer', body: null, credit: null }
			]
		});
	});

	it('keeps a half-filled credit so the API can point at the missing part', () => {
		const content = blockContentFromForm('gallery', form({ title: 'Galería', 'items.0.image': '/x.jpg', 'items.0.alt': 'Moto', 'items.0.title': 'Moto', 'items.0.author': 'Jane' }));
		expect(content).toMatchObject({ enabled: false, items: [{ credit: { author: 'Jane', license: '', sourceUrl: '' } }] });
	});

	it('reads the home teaser and menu link checkboxes, off unless checked', () => {
		const photo = { title: 'Galería', 'items.0.image': '/x.jpg', 'items.0.alt': 'Moto', 'items.0.title': 'Moto' };
		expect(blockContentFromForm('gallery', form(photo))).toMatchObject({ showOnHome: false, showInMenu: false });
		expect(blockContentFromForm('gallery', form({ ...photo, showOnHome: 'on' }))).toMatchObject({ showOnHome: true, showInMenu: false });
		expect(blockContentFromForm('gallery', form({ ...photo, showOnHome: 'on', showInMenu: 'on' }))).toMatchObject({ showOnHome: true, showInMenu: true });
	});

	it('names the photo and the part the API rejected', () => {
		expect(contentIssue({ issues: [{ path: 'items.0.credit.sourceUrl', message: 'Usá una dirección https' }] }, 'x')).toBe('Fotos, fila 1 (fuente): Usá una dirección https');
		expect(contentIssue({ issues: [{ path: 'items.2.alt', message: 'Too small' }] }, 'x')).toBe('Fotos, fila 3 (descripción): Too small');
		expect(contentIssue({ issues: [{ path: 'items', message: 'Too small' }] }, 'x')).toBe('Fotos: Too small');
	});
});

describe('editor rows', () => {
	it('offers two empty rows after the existing ones, up to the limit', () => {
		expect(editableRows([{ title: 'A', body: 'a' }], 8)).toEqual([{ title: 'A', body: 'a' }, { title: '', body: '' }, { title: '', body: '' }]);
		expect(editableRows(Array(8).fill({ title: 'A', body: 'a' }), 8)).toHaveLength(8);
		expect(editableRows(undefined, 8)).toHaveLength(2);
	});
});

describe('content issues', () => {
	it('names the field the API rejected', () => {
		expect(contentIssue({ issues: [{ path: 'services.1.body', message: 'Too small' }] }, 'No se pudo guardar')).toBe('Servicios, fila 2 (texto): Too small');
		expect(contentIssue({ issues: [{ path: 'heroVideoUrl', message: 'Usá un enlace de YouTube (https)' }] }, 'x')).toBe('Video: Usá un enlace de YouTube (https)');
		expect(contentIssue(undefined, 'No se pudo guardar')).toBe('No se pudo guardar');
	});
});

describe('FAQ order in the editor', () => {
	it('shows the stored 0-based position counted from 1', () => {
		expect([0, 1, 2, 3].map(faqOrder)).toEqual([1, 2, 3, 4]);
	});

	it('offers the number after the last question for a new one, also after a deletion leaves a gap', () => {
		expect(nextFaqOrder([0, 1, 2, 3].map((position) => ({ position })))).toBe(5);
		expect(nextFaqOrder([0, 1, 3].map((position) => ({ position })))).toBe(5);
		expect(nextFaqOrder([])).toBe(1);
	});

	it('stores the order typed from 1 as the 0-based position, an empty one first', () => {
		expect(faqPositionFromForm(form({ position: '1' }))).toBe(0);
		expect(faqPositionFromForm(form({ position: ' 5 ' }))).toBe(4);
		expect(faqPositionFromForm(form({ position: '' }))).toBe(0);
		expect(faqPositionFromForm(form({}))).toBe(0);
		expect(faqPositionFromForm(form({ position: String(nextFaqOrder([{ position: 3 }])) }))).toBe(4);
	});
});
