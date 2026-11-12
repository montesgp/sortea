import { randomUUID } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrationsFolder } from '../src/scripts/migrate';
import { testDatabaseName } from '../src/testing';

/**
 * The product-file-position migration (odd/tasks/owner-feedback-2026-11-11b.md,
 * S2, T5) on a database that already holds product files: each existing file
 * keeps its row and id (download links point to it) and takes position 0, the
 * first of its product; a product may then hold several files in order.
 * Found by its tag.
 */
const adminUrl = process.env.TEST_DATABASE_ADMIN_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const name = testDatabaseName('sortea_test_db_migration_product_file_position');
const url = Object.assign(new URL(adminUrl), { pathname: `/${name}` }).toString();
let scratch: string;

async function admin(statement: string) {
	const client = postgres(adminUrl, { max: 1, onnotice: () => {} });
	try {
		await client.unsafe(statement);
	} finally {
		await client.end();
	}
}

async function migrateWith(folder: string) {
	const client = postgres(url, { max: 1, onnotice: () => {} });
	try {
		await migrate(drizzle(client), { migrationsFolder: folder, migrationsSchema: 'app', migrationsTable: '__migrations' });
	} finally {
		await client.end();
	}
}

beforeAll(async () => {
	if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`Invalid test database name ${name}`);
	await admin(`drop database if exists ${name} with (force)`);
	await admin(`create database ${name}`);
	// The migrations before the product-file-position one only: the journal is cut there.
	scratch = mkdtempSync(join(tmpdir(), 'sortea-migration-'));
	cpSync(migrationsFolder, scratch, { recursive: true });
	const journalPath = join(scratch, 'meta', '_journal.json');
	const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { idx: number; tag: string }[] };
	const target = journal.entries.find((entry) => entry.tag.endsWith('_product_file_position'));
	if (!target) throw new Error('The product_file_position migration is not in the journal');
	writeFileSync(journalPath, JSON.stringify({ ...journal, entries: journal.entries.filter((entry) => entry.idx < target.idx) }));
	await migrateWith(scratch);
});

afterAll(async () => {
	if (scratch) rmSync(scratch, { recursive: true, force: true });
	await admin(`drop database if exists ${name} with (force)`);
});

describe('migration product_file_position', () => {
	it('puts each existing file first in its product and lets a product hold several in order', async () => {
		const org = randomUUID();
		const product = randomUUID();
		const asset = randomUUID();
		const sql = postgres(url, { max: 1, onnotice: () => {} });
		try {
			await sql`insert into app.organizations (id, slug, name, order_prefix, settings) values (${org}, ${`m-${org.slice(0, 8)}`}, 'M', 'MM', ${sql.json({})})`;
			await sql`insert into app.products (id, organization_id, slug, name, description, kind) values (${product}, ${org}, 'calcomania-digital', 'Calcomanía', 'd', 'digital')`;
			await sql`insert into app.product_assets (id, organization_id, product_id, storage_path, filename, content_type, size_bytes)
				values (${asset}, ${org}, ${product}, ${`${org}/${product}/aee2a90413206805.zip`}, 'Calcomania.zip', 'application/zip', 1000)`;
		} finally {
			await sql.end();
		}

		await migrateWith(migrationsFolder);

		const after = postgres(url, { max: 1, onnotice: () => {} });
		try {
			await after`insert into app.product_assets (organization_id, product_id, storage_path, filename, content_type, size_bytes, position)
				values (${org}, ${product}, ${`${org}/${product}/0123456789abcdef.png`}, 'Fondo.png', 'image/png', 200, 1)`;
			const rows = await after`select id, filename, position from app.product_assets where product_id = ${product} order by position`;
			expect(rows).toEqual([
				{ id: asset, filename: 'Calcomania.zip', position: 0 },
				{ id: rows[1]!.id, filename: 'Fondo.png', position: 1 }
			]);
		} finally {
			await after.end();
		}
	});
});
