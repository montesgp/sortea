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
 * Migration 0016 (odd/tasks/mercadopago-account-switch.md, S2, S4) on a database
 * that already holds orders: an organization keeps every Mercado Pago account it
 * used, one of them active, and each order records the account it was created
 * with. Orders of an organization with exactly one account get that account;
 * the others stay unassigned (legacy orders, matched by the collector).
 */
const adminUrl = process.env.TEST_DATABASE_ADMIN_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const name = 'sortea_test_db_migration_0016';
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
	// The migrations up to 0015 only: the journal is cut before 0016.
	scratch = mkdtempSync(join(tmpdir(), 'sortea-migration-'));
	cpSync(migrationsFolder, scratch, { recursive: true });
	const journalPath = join(scratch, 'meta', '_journal.json');
	const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { idx: number }[] };
	writeFileSync(journalPath, JSON.stringify({ ...journal, entries: journal.entries.filter((entry) => entry.idx <= 15) }));
	await migrateWith(scratch);
});

afterAll(async () => {
	if (scratch) rmSync(scratch, { recursive: true, force: true });
	await admin(`drop database if exists ${name} with (force)`);
});

describe('migration 0016 account history', () => {
	it('records the account of existing orders when there is only one, and keeps one active account per organization', async () => {
		const single = { org: randomUUID(), account: randomUUID(), order: randomUUID() };
		const switched = { org: randomUUID(), old: randomUUID(), current: randomUUID(), order: randomUUID() };
		const doubled = { org: randomUUID(), older: randomUUID(), newer: randomUUID() };
		const sql = postgres(url, { max: 1, onnotice: () => {} });
		try {
			const organization = (id: string, prefix: string) =>
				sql`insert into app.organizations (id, slug, name, order_prefix, settings) values (${id}, ${`m-${id.slice(0, 8)}`}, 'M', ${prefix}, ${sql.json({})})`;
			const account = (id: string, org: string, mode: string, active: boolean, updatedAt: string) =>
				sql`insert into app.organization_integrations (id, organization_id, provider, mode, sealed_secrets, key_version, secret_hint, is_active, updated_at)
					values (${id}, ${org}, 'mercadopago', ${mode}, 'sealed', 1, 'APP_••••1234', ${active}, ${updatedAt})`;
			const order = async (id: string, org: string) => {
				const contact = randomUUID();
				await sql`insert into app.contacts (id, organization_id, first_name, last_name, email) values (${contact}, ${org}, 'Ana', 'A', 'ana@example.com')`;
				await sql`insert into app.orders (id, organization_id, reference, access_code_hash, contact_id, buyer, currency, subtotal_minor, delivery_fee_minor, total_minor, delivery_method, pricing_snapshot, payment_provider, expires_at)
					values (${id}, ${org}, ${`R-${id.slice(0, 8)}`}, 'hash', ${contact}, ${sql.json({})}, 'ARS', 100, 0, 100, 'digital', ${sql.json({})}, 'mercadopago', now())`;
			};
			await organization(single.org, 'MA');
			await account(single.account, single.org, 'sandbox', true, '2026-10-01T00:00:00Z');
			await order(single.order, single.org);
			await organization(switched.org, 'MB');
			await account(switched.old, switched.org, 'sandbox', false, '2026-10-01T00:00:00Z');
			await account(switched.current, switched.org, 'production', true, '2026-10-02T00:00:00Z');
			await order(switched.order, switched.org);
			await organization(doubled.org, 'MC');
			await account(doubled.older, doubled.org, 'sandbox', true, '2026-10-01T00:00:00Z');
			await account(doubled.newer, doubled.org, 'production', true, '2026-10-02T00:00:00Z');
		} finally {
			await sql.end();
		}

		await migrateWith(migrationsFolder);

		const after = postgres(url, { max: 1, onnotice: () => {} });
		try {
			expect(await after`select payment_integration_id from app.orders where id = ${single.order}`).toEqual([{ payment_integration_id: single.account }]);
			expect(await after`select payment_integration_id from app.orders where id = ${switched.order}`).toEqual([{ payment_integration_id: null }]);

			const accounts = async (org: string) =>
				(await after`select id, is_active, retired_at is not null as retired from app.organization_integrations where organization_id = ${org} order by updated_at`).map((row) => ({ ...row }));
			expect(await accounts(single.org)).toEqual([{ id: single.account, is_active: true, retired: false }]);
			expect(await accounts(switched.org)).toEqual([
				{ id: switched.old, is_active: false, retired: true },
				{ id: switched.current, is_active: true, retired: false }
			]);
			// Two active accounts cannot coexist any more: the most recently updated one stays.
			expect(await accounts(doubled.org)).toEqual([
				{ id: doubled.older, is_active: false, retired: true },
				{ id: doubled.newer, is_active: true, retired: false }
			]);

			// Account history: several accounts in the same mode, only one of them active.
			const another = (active: boolean) =>
				after`insert into app.organization_integrations (organization_id, provider, mode, sealed_secrets, key_version, secret_hint, is_active, retired_at)
					values (${single.org}, 'mercadopago', 'sandbox', 'sealed', 1, 'APP_••••5678', ${active}, ${active ? null : new Date()})`;
			await another(false);
			await expect(another(true)).rejects.toThrow(/organization_integrations_active_uq/);

			// Deleting the accounts ("Desvincular cuenta") leaves the orders as legacy orders.
			await after`delete from app.organization_integrations where organization_id = ${single.org}`;
			expect(await after`select payment_integration_id from app.orders where id = ${single.order}`).toEqual([{ payment_integration_id: null }]);

			const policies = await after`select tablename from pg_policies where schemaname = 'app' and tablename in ('orders', 'organization_integrations') and policyname = 'tenant_isolation' order by tablename`;
			expect(policies.map((row) => row.tablename)).toEqual(['orders', 'organization_integrations']);
		} finally {
			await after.end();
		}
	});
});
