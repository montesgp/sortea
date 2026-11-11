import { describe, expect, it } from 'vitest';
import { newCampaignErrors, newCampaignFromForm } from './campaign-form';
import { campaignDate, campaignStatusChip } from './format';

/** "Nueva campaña" (S5, owner feedback 2026-11-10). */
const productId = '7f2a6f4e-2f41-4c8e-9a51-0d3c2b1a9e10';

function form(fields: Record<string, string>): FormData {
	const data = new FormData();
	const base = {
		title: 'Honda Wave 0 km',
		slug: 'honda-wave',
		subtitle: '',
		summary: 'Sorteamos una Honda Wave 0 km.',
		timezone: 'America/Argentina/Buenos_Aires',
		opensAt: '',
		closesAt: '',
		drawAt: '',
		seoTitle: '',
		seoDescription: '',
		minAge: '18',
		residency: 'República Argentina',
		rulesMarkdown: 'Bases iniciales de la campaña.'
	};
	for (const [key, value] of Object.entries({ ...base, ...fields })) data.set(key, value);
	return data;
}

describe('newCampaignFromForm', () => {
	it('sends a draft without dates and only the products that give chances', () => {
		const data = form({});
		data.set(`chances.${productId}`, '2');
		data.set('chances.00000000-0000-4000-8000-000000000000', '0');
		const read = newCampaignFromForm(data);
		expect(read.errors).toEqual({});
		expect(read.body).toEqual({
			title: 'Honda Wave 0 km',
			slug: 'honda-wave',
			subtitle: null,
			summary: 'Sorteamos una Honda Wave 0 km.',
			timezone: 'America/Argentina/Buenos_Aires',
			opensAt: null,
			closesAt: null,
			drawAt: null,
			seo: { title: undefined, description: undefined },
			eligibility: { minAge: 18, residency: 'República Argentina' },
			chancesPerProduct: { [productId]: 2 },
			rulesMarkdown: 'Bases iniciales de la campaña.'
		});
	});

	it('reads the dates in the campaign time zone', () => {
		const read = newCampaignFromForm(form({ opensAt: '2026-12-01T00:00', closesAt: '2026-12-24T20:00' }));
		expect(read.body).toMatchObject({ opensAt: '2026-12-01T03:00:00.000Z', closesAt: '2026-12-24T23:00:00.000Z', drawAt: null });
	});

	it('keeps what was typed and names the wrong fields', () => {
		const data = form({ opensAt: 'mañana' });
		data.set(`chances.${productId}`, '1,5');
		const read = newCampaignFromForm(data);
		expect(read.body).toBeNull();
		expect(read.errors).toEqual({ opensAt: 'Ingresá una fecha válida', chancesPerProduct: 'Las chances por unidad son un número entero de 0 a 100' });
		expect(read.values).toMatchObject({ title: 'Honda Wave 0 km', opensAt: 'mañana', chances: { [productId]: '1,5' } });
	});
});

describe('newCampaignErrors', () => {
	it('puts each API error next to its field', () => {
		expect(newCampaignErrors({ fieldErrors: { slug: ['Ya hay una campaña con esa dirección'], closesAt: ['El cierre tiene que ser posterior a la apertura'], eligibility: ['La edad mínima va de 16 a 99'] } })).toEqual({
			slug: 'Ya hay una campaña con esa dirección',
			closesAt: 'El cierre tiene que ser posterior a la apertura',
			minAge: 'La edad mínima va de 16 a 99'
		});
		expect(newCampaignErrors(undefined)).toEqual({});
	});

	it('puts nested errors under their own field, not the first one of the group', () => {
		expect(
			newCampaignErrors({
				fieldErrors: {
					'eligibility.residency': ['Indicá dónde tienen que residir'],
					'seo.description': ['La descripción para buscadores admite hasta 200 caracteres'],
					'chancesPerProduct.no-es-un-producto': ['Elegí productos de tu catálogo']
				}
			})
		).toEqual({
			residency: 'Indicá dónde tienen que residir',
			seoDescription: 'La descripción para buscadores admite hasta 200 caracteres',
			chancesPerProduct: 'Elegí productos de tu catálogo'
		});
		expect(newCampaignErrors({ fieldErrors: { 'eligibility.minAge': ['La edad mínima va de 16 a 99'], 'seo.title': ['El título para buscadores admite hasta 70 caracteres'] } })).toEqual({
			minAge: 'La edad mínima va de 16 a 99',
			seoTitle: 'El título para buscadores admite hasta 70 caracteres'
		});
	});
});

describe('campaign status in the admin', () => {
	it('says when a draft is still waiting for its dates', () => {
		expect(campaignStatusChip({ status: 'draft', opensAt: null, closesAt: null })).toEqual({ label: 'Borrador · fechas a definir', tone: 'neutral' });
		expect(campaignStatusChip({ status: 'review', opensAt: '2026-12-01T03:00:00Z', closesAt: null })).toEqual({ label: 'En revisión · fechas a definir', tone: 'neutral' });
		expect(campaignStatusChip({ status: 'draft', opensAt: '2026-12-01T03:00:00Z', closesAt: '2026-12-24T23:00:00Z' })).toEqual({ label: 'Borrador', tone: 'neutral' });
		expect(campaignStatusChip({ status: 'open', opensAt: '2026-12-01T03:00:00Z', closesAt: '2026-12-24T23:00:00Z' })).toEqual({ label: 'Participaciones abiertas', tone: 'ok' });
	});

	it('shows a missing date as "A definir"', () => {
		expect(campaignDate(null, 'America/Argentina/Buenos_Aires')).toBe('A definir');
		expect(campaignDate('2026-11-30T12:00:00Z', 'America/Argentina/Buenos_Aires')).toBe('30 nov, 09:00');
	});
});
