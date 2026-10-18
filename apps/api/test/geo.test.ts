import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, INTERNAL_TOKEN, loadGeoReference, type TestContext } from './helpers';

// S6 (feedback 2026-10-18): the checkout suggests countries, subdivisions and
// cities from our GeoNames copy. The data is the same for every organization.

let ctx: TestContext;

beforeAll(async () => {
	ctx = await createTestContext();
	await loadGeoReference(ctx);
});
afterAll(() => ctx.close());

// No tenant host: the reference data does not depend on the organization.
const get = (url: string, headers: Record<string, string> = { 'x-internal-token': INTERNAL_TOKEN }) => ctx.app.inject({ method: 'GET', url, headers });

async function cityNames(url: string) {
	const response = await get(url);
	expect(response.statusCode, response.body).toBe(200);
	return (response.json().cities as { name: string }[]).map((city) => city.name);
}

describe('world locations API (S6)', () => {
	it('answers only to the web tier', async () => {
		for (const url of ['/geo/countries', '/geo/countries/AR/subdivisions', '/geo/countries/AR/cities?q=ros']) {
			const response = await get(url, {});
			expect(response.statusCode, url).toBe(401);
			expect(response.json().error.code).toBe('internal_only');
		}
	});

	it('lists the countries by ISO code', async () => {
		const response = await get('/geo/countries');
		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({
			countries: [
				{ code: 'AR', name: 'Argentina' },
				{ code: 'BR', name: 'Brazil' },
				{ code: 'CL', name: 'Chile' },
				{ code: 'UY', name: 'Uruguay' }
			]
		});
	});

	it('lists the subdivisions of a country in Spanish order, with their accents', async () => {
		const response = await get('/geo/countries/ar/subdivisions');
		expect(response.statusCode).toBe(200);
		expect(response.json().subdivisions).toEqual([
			{ code: '01', name: 'Buenos Aires' },
			{ code: '02', name: 'Catamarca' },
			{ code: '07', name: 'Ciudad Autónoma de Buenos Aires' },
			{ code: '05', name: 'Córdoba' },
			{ code: '08', name: 'Entre Ríos' },
			{ code: '21', name: 'Santa Fe' }
		]);
	});

	it('searches cities by prefix, most populated first, naming their subdivision', async () => {
		const response = await get('/geo/countries/AR/cities?q=ros');
		expect(response.statusCode).toBe(200);
		expect(response.json().cities).toEqual([
			{ id: 3838583, name: 'Rosario', subdivision: { code: '21', name: 'Santa Fe' } },
			{ id: 3429439, name: 'Rosario del Tala', subdivision: { code: '08', name: 'Entre Ríos' } }
		]);
		// A prefix, not a substring.
		expect(await cityNames('/geo/countries/AR/cities?q=sario')).toEqual([]);
	});

	it('ignores case and accents', async () => {
		for (const q of ['rio c', 'RÍO C', 'Río  c', 'rÍo']) {
			expect(await cityNames(`/geo/countries/AR/cities?q=${encodeURIComponent(q)}`), q).toContain('Río Cuarto');
		}
		expect(await cityNames(`/geo/countries/BR/cities?q=${encodeURIComponent('sao')}`)).toEqual(['São Paulo']);
		expect(await cityNames(`/geo/countries/CL/cities?q=${encodeURIComponent('CHILLAN')}`)).toEqual(['Chillán']);
	});

	it('searches inside one subdivision when asked', async () => {
		expect(await cityNames('/geo/countries/AR/cities?q=ros&subdivision=08')).toEqual(['Rosario del Tala']);
		expect(await cityNames('/geo/countries/AR/cities?q=r&subdivision=05')).toEqual(['Río Cuarto', 'Río Tercero']);
		expect(await cityNames('/geo/countries/AR/cities?q=ros&subdivision=99')).toEqual([]);
	});

	it('shows a name repeated inside one subdivision once', async () => {
		const response = await get(`/geo/countries/AR/cities?q=${encodeURIComponent('san jose')}`);
		expect(response.json().cities).toEqual([{ id: 3837373, name: 'San José', subdivision: { code: '02', name: 'Catamarca' } }]);
	});

	it('bounds the results and treats wildcards as text', async () => {
		expect(await cityNames('/geo/countries/AR/cities?q=r')).toEqual(['Rosario', 'Río Cuarto', 'Rafaela', 'Río Tercero', 'Rosario del Tala']);
		expect(await cityNames('/geo/countries/AR/cities?q=r&limit=2')).toEqual(['Rosario', 'Río Cuarto']);
		expect(await cityNames(`/geo/countries/AR/cities?q=${encodeURIComponent('r%')}`)).toEqual([]);
		expect(await cityNames(`/geo/countries/AR/cities?q=${encodeURIComponent('r_sario')}`)).toEqual([]);
		for (const query of ['', 'q=', `q=${'x'.repeat(81)}`, 'q=%25%25', 'q=ros&limit=21', 'q=ros&limit=0', 'q=ros&subdivision=..%2F01']) {
			const response = await get(`/geo/countries/AR/cities?${query}`);
			expect(response.statusCode, query).toBe(400);
			expect(response.json().error.code).toBe('invalid_request');
		}
	});

	it('treats SQL text as a search term', async () => {
		expect(await cityNames(`/geo/countries/AR/cities?q=${encodeURIComponent("r'; drop table app.geo_cities;--")}`)).toEqual([]);
		expect((await get('/geo/countries')).statusCode).toBe(200);
		expect((await cityNames('/geo/countries/AR/cities?q=ro')).length).toBeGreaterThan(0);
	});

	it('answers 404 for a country it does not know and 400 for something that is not a code', async () => {
		for (const url of ['/geo/countries/ZZ/subdivisions', '/geo/countries/ZZ/cities?q=ciudad']) {
			const response = await get(url);
			expect(response.statusCode, url).toBe(404);
			expect(response.json().error).toMatchObject({ code: 'unknown_country', message: 'No conocemos ese país' });
		}
		for (const url of ['/geo/countries/ARG/subdivisions', '/geo/countries/A1/cities?q=ros']) {
			expect((await get(url)).statusCode, url).toBe(400);
		}
	});
});
