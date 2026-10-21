import { randomUUID } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrationsFolder } from '../src/scripts/migrate';

/**
 * Migration 0010 (ADR 0014 §1) on a database that already holds campaigns and orders:
 * existing counters keep running, only new campaigns start at 0000.
 */
const adminUrl = process.env.TEST_DATABASE_ADMIN_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const name = 'sortea_test_db_migration_0010';
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
	await admin(`drop database if exists ${name} with (force)`);
	await admin(`create database ${name}`);
	// The migrations up to 0009 only: the journal is cut before 0010.
	scratch = mkdtempSync(join(tmpdir(), 'sortea-migration-'));
	cpSync(migrationsFolder, scratch, { recursive: true });
	const journalPath = join(scratch, 'meta', '_journal.json');
	const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { idx: number }[] };
	writeFileSync(journalPath, JSON.stringify({ ...journal, entries: journal.entries.filter((entry) => entry.idx <= 9) }));
	await migrateWith(scratch);
});

afterAll(async () => {
	if (scratch) rmSync(scratch, { recursive: true, force: true });
	await admin(`drop database if exists ${name} with (force)`);
});

describe('migration 0010 coupon pool', () => {
	it('keeps existing counters and orders, and starts only new campaigns at 0', async () => {
		const ids = { org: randomUUID(), campaign: randomUUID(), contact: randomUUID(), order: randomUUID() };
		const sql = postgres(url, { max: 1, onnotice: () => {} });
		try {
			await sql`insert into app.organizations (id, slug, name, order_prefix, settings) values (${ids.org}, ${`m-${ids.org.slice(0, 8)}`}, 'M', 'MM', ${sql.json({})})`;
			await sql`insert into app.campaigns (id, organization_id, slug, title, summary, timezone, opens_at, closes_at, next_entry_number)
				values (${ids.campaign}, ${ids.org}, 'c', 'C', 'S', 'UTC', now(), now() + interval '1 day', 58)`;
			await sql`insert into app.contacts (id, organization_id, first_name, last_name, email) values (${ids.contact}, ${ids.org}, 'A', 'B', 'a@example.com')`;
			await sql`insert into app.orders (id, organization_id, reference, access_code_hash, contact_id, buyer, campaign_id, currency, subtotal_minor, delivery_fee_minor,
				total_minor, delivery_method, pricing_snapshot, payment_provider, expires_at)
				values (${ids.order}, ${ids.org}, 'MM-1', 'x', ${ids.contact}, ${sql.json({ firstName: 'A', lastName: 'B', email: 'a@example.com', phone: null })}, ${ids.campaign},
				'ARS', 100, 0, 100, 'digital', ${sql.json({})}, 'mercadopago', now() + interval '1 hour')`;
		} finally {
			await sql.end();
		}

		await migrateWith(migrationsFolder);

		const after = postgres(url, { max: 1, onnotice: () => {} });
		try {
			const [campaign] = await after`select next_entry_number, entry_digits from app.campaigns where id = ${ids.campaign}`;
			expect(campaign).toEqual({ next_entry_number: 58, entry_digits: 4 });
			const [order] = await after`select status, reserved_entries from app.orders where id = ${ids.order}`;
			expect(order).toEqual({ status: 'pending_payment', reserved_entries: 0 });
			const [column] = await after`select column_default from information_schema.columns
				where table_schema = 'app' and table_name = 'campaigns' and column_name = 'next_entry_number'`;
			expect(column!.column_default).toBe('0');
		} finally {
			await after.end();
		}
	});
});
