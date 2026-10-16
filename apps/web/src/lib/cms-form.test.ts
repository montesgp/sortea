import { describe, expect, it } from 'vitest';
import { blockContentFromForm, contentIssue, editableRows } from './cms-form';

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
			ctaBody: null
		});
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
		expect(blockContentFromForm('brand', form({ logo: '', logoAlt: 'MotoGarage', tagline: 'Motos' }))).toEqual({ logo: null, logoAlt: 'MotoGarage', tagline: 'Motos' });
		expect(blockContentFromForm('seo', form({ title: 'MotoGarage', description: 'Taller', image: 'media:x' }))).toEqual({ title: 'MotoGarage', description: 'Taller', image: 'media:x' });
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
				'items.0.image': '/tenants/motogarage/restauraciones/honda.jpg',
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
					image: '/tenants/motogarage/restauraciones/honda.jpg',
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
