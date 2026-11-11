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
 * The payment-event-account migration (odd/tasks/console-polish-2026-11-11.md,
 * S6) on a database that already holds Mercado Pago notifications: they keep a
 * null account, new ones can name the account that signed them, the table stays
 * append-only, and deleting the accounts ("Desvincular") keeps the
 * notifications, since the column has no foreign key. Found by its tag.
 */
const adminUrl = process.env.TEST_DATABASE_ADMIN_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const name = testDatabaseName('sortea_test_db_migration_payment_event_account');
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
	// The migrations before the payment-event-account one only: the journal is cut there.
	scratch = mkdtempSync(join(tmpdir(), 'sortea-migration-'));
	cpSync(migrationsFolder, scratch, { recursive: true });
	const journalPath = join(scratch, 'meta', '_journal.json');
	const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { idx: number; tag: string }[] };
	const target = journal.entries.find((entry) => entry.tag.endsWith('_payment_event_account'));
	if (!target) throw new Error('The payment_event_account migration is not in the journal');
	writeFileSync(journalPath, JSON.stringify({ ...journal, entries: journal.entries.filter((entry) => entry.idx < target.idx) }));
	await migrateWith(scratch);
});

afterAll(async () => {
	if (scratch) rmSync(scratch, { recursive: true, force: true });
	await admin(`drop database if exists ${name} with (force)`);
});

describe('migration payment_event_account', () => {
	it('keeps existing notifications without an account and outlives the deleted accounts', async () => {
		const org = randomUUID();
		const account = randomUUID();
		const sql = postgres(url, { max: 1, onnotice: () => {} });
		try {
			await sql`insert into app.organizations (id, slug, name, order_prefix, settings) values (${org}, ${`m-${org.slice(0, 8)}`}, 'M', 'MM', ${sql.json({})})`;
			await sql`insert into app.organization_integrations (id, organization_id, provider, mode, sealed_secrets, key_version, secret_hint)
				values (${account}, ${org}, 'mercadopago', 'sandbox', 'v1.sealed', 1, 'TEST••••')`;
			await sql`insert into app.payment_events (organization_id, provider, topic, provider_payment_id, signature_valid, outcome)
				values (${org}, 'mercadopago', 'order', 'ORD01BEFORE', true, 'paid')`;
		} finally {
			await sql.end();
		}

		await migrateWith(migrationsFolder);

		const after = postgres(url, { max: 1, onnotice: () => {} });
		try {
			await after`insert into app.payment_events (organization_id, provider, topic, provider_payment_id, signature_valid, integration_id, outcome)
				values (${org}, 'mercadopago', 'order', 'ORD01AFTER', true, ${account}, 'paid')`;
			const rows = await after`select provider_payment_id, integration_id from app.payment_events where organization_id = ${org} order by provider_payment_id`;
			expect(rows).toEqual([
				{ provider_payment_id: 'ORD01AFTER', integration_id: account },
				{ provider_payment_id: 'ORD01BEFORE', integration_id: null }
			]);
			await expect(after`update app.payment_events set integration_id = null where organization_id = ${org}`).rejects.toMatchObject({ code: '42501' });

			await after`delete from app.organization_integrations where id = ${account}`;
			const kept = await after`select integration_id from app.payment_events where provider_payment_id = 'ORD01AFTER'`;
			expect(kept).toEqual([{ integration_id: account }]);
		} finally {
			await after.end();
		}
	});
});
