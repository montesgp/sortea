import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import { locationSearchKey } from '@sortea/domain';
import { getTableColumns, sql, type SQL } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { createDatabase, type DatabaseHandle, type Tx } from '../client';
import * as s from '../schema';
import { databaseUrl } from './env';

/**
 * Loads world locations from the GeoNames dump (CC BY 4.0, https://www.geonames.org)
 * into the reference tables (S6, ADR 0012).
 *
 *   pnpm db:geo            downloads the files into .cache/geonames/ (once) and imports them
 *   pnpm db:geo <dir>      imports countryInfo.txt, admin1CodesASCII.txt and
 *                          cities1000.txt (or cities1000.zip) from <dir>
 *
 * Every run upserts in one transaction, so it can be repeated; rows GeoNames
 * dropped stay (orders keep names, not references to these rows).
 */

const DUMP_URL = 'https://download.geonames.org/export/dump/';
const FILES = ['countryInfo.txt', 'admin1CodesASCII.txt', 'cities1000.zip'] as const;
export const geoCacheDir = fileURLToPath(new URL('../../../../.cache/geonames', import.meta.url));

/**
 * GeoNames writes some Argentine provinces without accents and calls the capital
 * "Buenos Aires F.D.". The organizations' own country keeps the names its buyers
 * have always picked (ADR 0012).
 */
const subdivisionNames: Record<string, string> = {
	'AR.05': 'Córdoba',
	'AR.07': 'Ciudad Autónoma de Buenos Aires',
	'AR.08': 'Entre Ríos',
	'AR.15': 'Neuquén',
	'AR.16': 'Río Negro',
	'AR.24': 'Tucumán'
};

export interface GeoImportCounts {
	countries: number;
	subdivisions: number;
	cities: number;
	/** Rows whose country is not in countryInfo.txt. */
	skipped: { subdivisions: number; cities: number };
}

type Country = typeof s.geoCountries.$inferInsert;
type Subdivision = typeof s.geoSubdivisions.$inferInsert;
type City = typeof s.geoCities.$inferInsert;

export async function importGeoNames(handle: DatabaseHandle, dir: string, options: { batchSize?: number } = {}): Promise<GeoImportCounts> {
	const batchSize = options.batchSize ?? 1000;
	const countries = parseCountries(await readFile(join(dir, 'countryInfo.txt'), 'utf8'));
	const known = new Set(countries.map((country) => country.code));
	const subdivisions = parseSubdivisions(await readFile(join(dir, 'admin1CodesASCII.txt'), 'utf8'), known);
	const cities = parseCities(await readCities(dir), known);

	return handle.withPlatform((db) =>
		db.transaction(async (tx) => {
			for (const batch of batches(countries, batchSize)) {
				await tx
					.insert(s.geoCountries)
					.values(batch)
					.onConflictDoUpdate({ target: s.geoCountries.code, set: excluded(s.geoCountries, ['iso3', 'name', 'continent', 'geonameId']) });
			}
			for (const batch of batches(subdivisions.rows, batchSize)) {
				await tx
					.insert(s.geoSubdivisions)
					.values(batch)
					.onConflictDoUpdate({
						target: [s.geoSubdivisions.countryCode, s.geoSubdivisions.code],
						set: excluded(s.geoSubdivisions, ['name', 'asciiName', 'geonameId'])
					});
			}
			for (const batch of batches(cities.rows, batchSize)) {
				await tx
					.insert(s.geoCities)
					.values(batch)
					.onConflictDoUpdate({
						target: s.geoCities.geonameId,
						set: excluded(s.geoCities, ['countryCode', 'subdivisionCode', 'name', 'asciiName', 'searchName', 'population'])
					});
			}
			return {
				countries: await count(tx, 'geo_countries'),
				subdivisions: await count(tx, 'geo_subdivisions'),
				cities: await count(tx, 'geo_cities'),
				skipped: { subdivisions: subdivisions.skipped, cities: cities.skipped }
			};
		})
	);
}

/** Downloads the dump files missing from `dir`. Delete the directory to refresh them. */
export async function downloadGeoNames(dir: string): Promise<void> {
	await mkdir(dir, { recursive: true });
	for (const file of FILES) {
		const target = join(dir, file);
		if (existsSync(target)) continue;
		console.log(`Downloading ${DUMP_URL}${file}`);
		const response = await fetch(`${DUMP_URL}${file}`, { signal: AbortSignal.timeout(300_000) });
		if (!response.ok) throw new Error(`GeoNames answered ${response.status} for ${file}`);
		// Written aside and renamed, so an interrupted download is never mistaken for a complete one.
		await writeFile(`${target}.part`, Buffer.from(await response.arrayBuffer()));
		await rename(`${target}.part`, target);
	}
}

function parseCountries(text: string): Country[] {
	// ISO, ISO3, ISO-Numeric, fips, Country, Capital, Area, Population, Continent, tld, ..., geonameid (16)
	return rows(text).map((fields) => ({
		code: fields[0]!,
		iso3: fields[1]!,
		name: fields[4]!,
		continent: fields[8]!,
		geonameId: integerOrNull(fields[16])
	}));
}

function parseSubdivisions(text: string, known: Set<string>): { rows: Subdivision[]; skipped: number } {
	// "AR.21", name, ascii name, geonameid
	const parsed: Subdivision[] = [];
	let skipped = 0;
	for (const fields of rows(text)) {
		const key = fields[0]!;
		const [countryCode, code] = [key.slice(0, key.indexOf('.')), key.slice(key.indexOf('.') + 1)];
		if (!known.has(countryCode) || !code) {
			skipped += 1;
			continue;
		}
		parsed.push({
			countryCode,
			code,
			name: subdivisionNames[key] ?? fields[1]!,
			asciiName: fields[2]!,
			geonameId: integerOrNull(fields[3])
		});
	}
	return { rows: parsed, skipped };
}

function parseCities(text: string, known: Set<string>): { rows: City[]; skipped: number } {
	// geonameid, name, asciiname, alternatenames, lat, lng, class, code, country (8), cc2, admin1 (10), ..., population (14)
	const parsed: City[] = [];
	let skipped = 0;
	for (const fields of rows(text)) {
		const countryCode = fields[8]!;
		if (!known.has(countryCode)) {
			skipped += 1;
			continue;
		}
		const name = fields[1]!;
		parsed.push({
			geonameId: Number(fields[0]),
			countryCode,
			subdivisionCode: fields[10] || null,
			name,
			asciiName: fields[2]!,
			searchName: locationSearchKey(name),
			population: integerOrNull(fields[14]) ?? 0
		});
	}
	return { rows: parsed, skipped };
}

async function readCities(dir: string): Promise<string> {
	const text = join(dir, 'cities1000.txt');
	if (existsSync(text)) return readFile(text, 'utf8');
	return readZipEntry(await readFile(join(dir, 'cities1000.zip')), 'cities1000.txt').toString('utf8');
}

/** Reads one entry of a zip archive (stored or deflated, no ZIP64): enough for the GeoNames dump. */
export function readZipEntry(zip: Buffer, name: string): Buffer {
	let end = zip.length - 22;
	while (end >= 0 && zip.readUInt32LE(end) !== 0x06054b50) end -= 1;
	if (end < 0) throw new Error('Not a zip archive');
	const entries = zip.readUInt16LE(end + 10);
	let offset = zip.readUInt32LE(end + 16);
	for (let index = 0; index < entries; index += 1) {
		if (zip.readUInt32LE(offset) !== 0x02014b50) throw new Error('Corrupt zip central directory');
		const method = zip.readUInt16LE(offset + 10);
		const compressedSize = zip.readUInt32LE(offset + 20);
		const nameLength = zip.readUInt16LE(offset + 28);
		const extraLength = zip.readUInt16LE(offset + 30);
		const commentLength = zip.readUInt16LE(offset + 32);
		const localOffset = zip.readUInt32LE(offset + 42);
		const entryName = zip.toString('utf8', offset + 46, offset + 46 + nameLength);
		if (entryName === name) {
			if (compressedSize === 0xffffffff || localOffset === 0xffffffff) throw new Error('ZIP64 archives are not supported');
			const dataStart = localOffset + 30 + zip.readUInt16LE(localOffset + 26) + zip.readUInt16LE(localOffset + 28);
			const data = zip.subarray(dataStart, dataStart + compressedSize);
			if (method === 0) return Buffer.from(data);
			if (method === 8) return inflateRawSync(data);
			throw new Error(`Unsupported zip compression method ${method}`);
		}
		offset += 46 + nameLength + extraLength + commentLength;
	}
	throw new Error(`${name} is not in the archive`);
}

function rows(text: string): string[][] {
	return text
		.split('\n')
		.map((line) => line.replace(/\r$/, ''))
		.filter((line) => line && !line.startsWith('#'))
		.map((line) => line.split('\t'));
}

function integerOrNull(value: string | undefined): number | null {
	if (!value || !/^\d+$/.test(value)) return null;
	return Number(value);
}

function* batches<T>(items: T[], size: number): Generator<T[]> {
	for (let start = 0; start < items.length; start += size) yield items.slice(start, start + size);
}

/** `set` for an upsert: the listed columns take the incoming row's values. */
function excluded<T extends PgTable>(table: T, keys: (keyof T['$inferInsert'] & string)[]): Record<string, SQL> {
	const columns = getTableColumns(table) as Record<string, { name: string }>;
	return Object.fromEntries([...keys.map((key) => [key, sql.raw(`excluded.${columns[key]!.name}`)]), ['updatedAt', sql`now()`]]);
}

async function count(tx: Tx, table: 'geo_countries' | 'geo_subdivisions' | 'geo_cities'): Promise<number> {
	const [row] = await tx.execute<{ count: number }>(sql`select count(*)::int as count from ${sql.identifier('app')}.${sql.identifier(table)}`);
	return row!.count;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	// pnpm runs the script from packages/db; a relative directory is meant from where the command was typed.
	const argument = process.argv[2];
	const dir = argument ? resolve(process.env.INIT_CWD ?? process.cwd(), argument) : geoCacheDir;
	if (!argument) await downloadGeoNames(dir);
	const handle = createDatabase(databaseUrl(), { max: 1 });
	try {
		const counts = await importGeoNames(handle, dir);
		console.log(
			`GeoNames imported: ${counts.countries} countries, ${counts.subdivisions} subdivisions, ${counts.cities} cities` +
				` (skipped ${counts.skipped.subdivisions} subdivisions and ${counts.skipped.cities} cities of unknown countries)`
		);
	} finally {
		await handle.close();
	}
}
