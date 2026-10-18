import { asc, eq, schema as s, sql, type DatabaseHandle, type Tx } from '@sortea/db';
import { citySearchSchema, countryCodeSchema, locationSearchKey } from '@sortea/domain';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ApiError, parse } from '../lib/errors';

const countryParams = z.object({ country: countryCodeSchema });

/**
 * World locations for the checkout (S6, ADR 0012): GeoNames reference data,
 * the same for every organization. Reached only through the web tier, with the
 * internal token like every route, and read with the restricted app role.
 */
export async function geoRoutes(app: FastifyInstance) {
	const { deps } = app;

	app.get('/geo/countries', async () => {
		const countries = await readReference(deps.db, (tx) =>
			tx.select({ code: s.geoCountries.code, name: s.geoCountries.name }).from(s.geoCountries).orderBy(asc(s.geoCountries.code))
		);
		return { countries };
	});

	app.get('/geo/countries/:country/subdivisions', async (request) => {
		const { country } = parse(countryParams, request.params);
		const subdivisions = await readReference(deps.db, async (tx) => {
			await requireCountry(tx, country);
			return tx
				.select({ code: s.geoSubdivisions.code, name: s.geoSubdivisions.name })
				.from(s.geoSubdivisions)
				.where(eq(s.geoSubdivisions.countryCode, country));
		});
		return { subdivisions: subdivisions.sort((a, b) => a.name.localeCompare(b.name, 'es')) };
	});

	app.get('/geo/countries/:country/cities', async (request) => {
		const { country } = parse(countryParams, request.params);
		const query = parse(citySearchSchema, request.query);
		const prefix = `${escapeLike(locationSearchKey(query.q))}%`;
		const rows = await readReference(deps.db, async (tx) => {
			await requireCountry(tx, country);
			// Places sharing a name inside one subdivision show once, as the most populated.
			return tx.execute<{ id: number; name: string; subdivision_code: string | null; subdivision_name: string | null }>(sql`
				select id, name, subdivision_code, subdivision_name from (
					select distinct on (c.name, c.subdivision_code)
						c.geoname_id as id, c.name, c.subdivision_code, d.name as subdivision_name, c.population
					from app.geo_cities c
					left join app.geo_subdivisions d on d.country_code = c.country_code and d.code = c.subdivision_code
					where c.country_code = ${country} and c.search_name like ${prefix}
						${query.subdivision ? sql`and c.subdivision_code = ${query.subdivision}` : sql``}
					order by c.name, c.subdivision_code, c.population desc
				) found
				order by population desc, name
				limit ${query.limit}`);
		});
		return {
			cities: rows.map((row) => ({
				id: row.id,
				name: row.name,
				subdivision: row.subdivision_code && row.subdivision_name ? { code: row.subdivision_code, name: row.subdivision_name } : null
			}))
		};
	});
}

/** Reference data is read as the restricted app role, which may read it and nothing of any organization. */
function readReference<T>(db: DatabaseHandle, fn: (tx: Tx) => Promise<T>): Promise<T> {
	return db.withPlatform((database) =>
		database.transaction(async (tx) => {
			await tx.execute(sql`set local role sortea_app`);
			return fn(tx);
		})
	);
}

async function requireCountry(tx: Tx, country: string): Promise<void> {
	const [known] = await tx.select({ code: s.geoCountries.code }).from(s.geoCountries).where(eq(s.geoCountries.code, country));
	if (!known) throw new ApiError(404, 'unknown_country', 'No conocemos ese país');
}

function escapeLike(value: string): string {
	return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}
