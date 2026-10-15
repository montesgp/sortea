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
