import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateRawSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { asc, createDatabase, eq, schema as s, sql, type DatabaseHandle, type Tx } from '../src';
import { importGeoNames } from '../src/scripts/import-geonames';

// S6 (feedback 2026-10-18): countries, first-level subdivisions and cities from
// GeoNames, imported into our database. Tests read tiny fixture files, never the network.

const fixtures = fileURLToPath(new URL('./fixtures/geonames', import.meta.url));
const expected = { countries: 4, subdivisions: 10, cities: 15, skipped: { subdivisions: 1, cities: 1 } };

let handle: DatabaseHandle;
const scratch: string[] = [];

beforeAll(() => {
	handle = createDatabase(inject('databaseUrl'), { max: 3 });
});

afterAll(async () => {
	await handle.close();
	await Promise.all(scratch.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function snapshot() {
	return handle.withPlatform(async (db) => ({
		countries: await db.select().from(s.geoCountries).orderBy(asc(s.geoCountries.code)),
		subdivisions: await db.select().from(s.geoSubdivisions).orderBy(asc(s.geoSubdivisions.countryCode), asc(s.geoSubdivisions.code)),
		cities: await db.select().from(s.geoCities).orderBy(asc(s.geoCities.geonameId))
	}));
}

const withoutTimes = <T extends { updatedAt: Date }>(rows: T[]) => rows.map(({ updatedAt: _updatedAt, ...row }) => row);

describe('GeoNames import (S6)', () => {
	it('loads countries, subdivisions and cities, skipping rows of unknown countries', async () => {
		const counts = await importGeoNames(handle, fixtures);
		expect(counts).toEqual(expected);

		const { countries, subdivisions, cities } = await snapshot();
		expect(countries.map((country) => country.code)).toEqual(['AR', 'BR', 'CL', 'UY']);
		expect(countries[0]).toMatchObject({ code: 'AR', iso3: 'ARG', name: 'Argentina', continent: 'SA', geonameId: 3865483 });
		expect(subdivisions).toHaveLength(10);
		expect(cities).toHaveLength(15);
	});

	it('keeps names with accents and gives Argentina the names its buyers use', async () => {
		const { subdivisions, cities } = await snapshot();
		const name = (country: string, code: string) => subdivisions.find((row) => row.countryCode === country && row.code === code)?.name;
		expect(name('BR', '27')).toBe('São Paulo');
		expect(name('CL', '18')).toBe('Ñuble');
		// GeoNames writes these without accents and calls the capital "Buenos Aires F.D." (ADR 0012).
		expect(name('AR', '05')).toBe('Córdoba');
		expect(name('AR', '08')).toBe('Entre Ríos');
		expect(name('AR', '07')).toBe('Ciudad Autónoma de Buenos Aires');
		expect(name('AR', '21')).toBe('Santa Fe');

		const rioCuarto = cities.find((city) => city.geonameId === 3838874);
		expect(rioCuarto).toMatchObject({
			countryCode: 'AR',
			subdivisionCode: '05',
			name: 'Río Cuarto',
			asciiName: 'Rio Cuarto',
			searchName: 'rio cuarto',
			population: 157010
		});
	});

	it('is idempotent: a second run upserts the same rows', async () => {
		const before = await snapshot();
		expect(await importGeoNames(handle, fixtures, { batchSize: 4 })).toEqual(expected);
		const after = await snapshot();
		expect(withoutTimes(after.countries)).toEqual(withoutTimes(before.countries));
		expect(withoutTimes(after.subdivisions)).toEqual(withoutTimes(before.subdivisions));
		expect(withoutTimes(after.cities)).toEqual(withoutTimes(before.cities));
	});

	it('reads cities from the zip GeoNames publishes', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'sortea-geonames-'));
		scratch.push(dir);
		await copyFile(join(fixtures, 'countryInfo.txt'), join(dir, 'countryInfo.txt'));
		await copyFile(join(fixtures, 'admin1CodesASCII.txt'), join(dir, 'admin1CodesASCII.txt'));
		await writeFile(join(dir, 'cities1000.zip'), zipOf('cities1000.txt', await readFile(join(fixtures, 'cities1000.txt'))));
		expect(await importGeoNames(handle, dir)).toEqual(expected);
	});

	it('lets the app role read the reference data and never write it', async () => {
		const organization = randomUUID();
		const read = await handle.withTenant(organization, (tx) => tx.select().from(s.geoCountries).where(eq(s.geoCountries.code, 'UY')));
		expect(read.map((row) => row.name)).toEqual(['Uruguay']);

		const attempts = [
			(tx: Tx) => tx.insert(s.geoCountries).values({ code: 'XX', iso3: 'XXX', name: 'X', continent: 'SA' }),
			(tx: Tx) => tx.update(s.geoSubdivisions).set({ name: 'Hacked' }),
			(tx: Tx) => tx.delete(s.geoCities),
			(tx: Tx) => tx.execute(sql`truncate app.geo_cities`)
		];
		for (const attempt of attempts) {
			const error = await handle.withTenant(organization, attempt).then(
				() => null,
				(caught: Error & { cause?: Error }) => caught
			);
			expect(error, 'expected the database to reject the statement').toBeInstanceOf(Error);
			expect(`${error!.message} ${error!.cause?.message ?? ''}`).toMatch(/permission denied/);
		}
		const { countries, subdivisions, cities } = await snapshot();
		expect([countries.length, subdivisions.length, cities.length]).toEqual([4, 10, 15]);
	});
});

/** A one-entry zip archive, deflated, as `cities1000.zip` is published. */
function zipOf(name: string, content: Buffer): Buffer {
	const data = deflateRawSync(content);
	const fileName = Buffer.from(name);
	const crc = crc32(content);
	const local = Buffer.alloc(30);
	local.writeUInt32LE(0x04034b50, 0);
	local.writeUInt16LE(20, 4);
	local.writeUInt16LE(8, 8);
	local.writeUInt32LE(crc, 14);
	local.writeUInt32LE(data.length, 18);
	local.writeUInt32LE(content.length, 22);
	local.writeUInt16LE(fileName.length, 26);
	const central = Buffer.alloc(46);
	central.writeUInt32LE(0x02014b50, 0);
	central.writeUInt16LE(20, 4);
	central.writeUInt16LE(20, 6);
	central.writeUInt16LE(8, 10);
	central.writeUInt32LE(crc, 16);
	central.writeUInt32LE(data.length, 20);
	central.writeUInt32LE(content.length, 24);
	central.writeUInt16LE(fileName.length, 28);
	central.writeUInt32LE(0, 42);
	const centralOffset = local.length + fileName.length + data.length;
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(1, 8);
	end.writeUInt16LE(1, 10);
	end.writeUInt32LE(central.length + fileName.length, 12);
	end.writeUInt32LE(centralOffset, 16);
	return Buffer.concat([local, fileName, data, central, fileName, end]);
}
