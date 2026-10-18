import type { Sql, TransactionSql } from 'postgres';

/**
 * Operator-only erasure of one organization (ADR 0011). It removes every row
 * carrying the organization's id, append-only tables included, then its files.
 * There is no UI or API path to it, and nothing calls it on a schedule.
 */

/** Files of an organization live under `<organizationId>/` in each bucket. */
export interface OrganizationStorage {
	readonly buckets: readonly string[];
	/** Every object path under `prefix`, recursively. */
	list(bucket: string, prefix: string): Promise<string[]>;
	remove(bucket: string, paths: string[]): Promise<void>;
}

export class ErasureRefusedError extends Error {}

export interface ErasurePlan {
	organization: { id: string; slug: string; name: string };
	/** Rows per app table, only tables that have some. */
	counts: Record<string, number>;
	/** Objects per bucket; null when storage is not configured. */
	storageCounts: Record<string, number> | null;
	productionPaymentIntegrations: number;
}

export interface ErasureResult extends ErasurePlan {
	/** Objects removed per bucket after the commit; null when storage is not configured. */
	storageRemoved: Record<string, number> | null;
	/** Buckets whose cleanup failed. The database erasure stands regardless. */
	storageErrors: string[];
}

export interface EraseOptions {
	slug: string;
	confirm: string | undefined;
	allowProduction: boolean;
	storage: OrganizationStorage | null;
	/** Erase the rows only: the files under `<organizationId>/` stay, even with storage configured. */
	skipStorage?: boolean;
}

type Executor = Sql | TransactionSql;

interface OrganizationRow {
	id: string;
	slug: string;
	name: string;
}

const REMOVE_BATCH = 100;

/** Dry run: what an erasure would remove. Reads only. */
export async function planErasure(sql: Sql, slug: string, storage: OrganizationStorage | null): Promise<ErasurePlan> {
	const organization = await findOrganization(sql, slug);
	return {
		organization,
		counts: await countRows(sql, organization.id),
		storageCounts: storage ? await countObjects(storage, organization.id) : null,
		productionPaymentIntegrations: await productionPaymentIntegrations(sql, organization.id)
	};
}

/**
 * Deletes the organization in one transaction. Append-only and protect triggers
 * (and foreign key checks, which are triggers too) are skipped only inside it,
 * through `session_replication_role = replica`; normal mode is restored before
 * the checks, the organization row and the audit record.
 */
export async function eraseOrganization(sql: Sql, options: EraseOptions): Promise<ErasureResult> {
	const plan = await planErasure(sql, options.slug, options.storage);
	if (options.confirm !== options.slug) {
		throw new ErasureRefusedError(`Refusing to erase ${options.slug}: confirm with --confirm ${options.slug}`);
	}
	assertNotProduction(plan.productionPaymentIntegrations, options);

	const { id, slug, name } = plan.organization;
	const counts = await sql.begin(async (tx) => {
		const [locked] = await tx<OrganizationRow[]>`select id, slug, name from app.organizations where id = ${id} for update`;
		if (!locked) throw new ErasureRefusedError(`Refusing to erase ${slug}: the organization no longer exists`);
		// Checked again under the lock: an account may have switched to production since the plan.
		assertNotProduction(await productionPaymentIntegrations(tx, id), options);

		await tx`set local session_replication_role = replica`;
		const deleted: Record<string, number> = {};
		for (const table of await organizationTables(tx)) {
			const result = await tx`delete from app.${tx(table)} where organization_id = ${id}`;
			if (result.count > 0) deleted[table] = result.count;
		}
		await tx`set local session_replication_role = origin`;

		const remaining = await countRows(tx, id);
		if (Object.keys(remaining).length > 0) {
			throw new Error(`Erasure of ${slug} left rows behind (${JSON.stringify(remaining)}); rolled back`);
		}
		const orphans = await danglingReferences(tx);
		if (orphans.length > 0) {
			throw new Error(`Erasure of ${slug} would leave references to deleted rows (${orphans.join(', ')}); rolled back`);
		}
		// Normal mode again: the foreign keys to organizations confirm nothing points here any more.
		await tx`delete from app.organizations where id = ${id}`;
		const metadata = { slug, name, counts: deleted, storageCounts: plan.storageCounts };
		await tx`
			insert into app.audit_events (organization_id, actor_type, action, target_type, target_id, metadata)
			values (null, 'operator', 'organization.erased', 'organization', ${id}, ${tx.json(metadata)})`;
		return deleted;
	});

	const storage = options.skipStorage ? null : options.storage;
	const { storageRemoved, storageErrors } = storage ? await removeObjects(storage, id) : { storageRemoved: null, storageErrors: [] };
	return { ...plan, counts, storageRemoved, storageErrors };
}

function assertNotProduction(productionIntegrations: number, options: EraseOptions): void {
	if (productionIntegrations > 0 && !options.allowProduction) {
		throw new ErasureRefusedError(
			`Refusing to erase ${options.slug}: it has a Mercado Pago integration in production mode; add --allow-production to erase it anyway`
		);
	}
}

async function findOrganization(sql: Executor, slug: string): Promise<OrganizationRow> {
	const [organization] = await sql<OrganizationRow[]>`select id, slug, name from app.organizations where slug = ${slug}`;
	if (!organization) throw new ErasureRefusedError(`Refusing to erase ${slug}: no organization has that slug`);
	return organization;
}

/** Every table in `app` with an `organization_id` column, found in the catalog so new tables are covered. */
async function organizationTables(sql: Executor): Promise<string[]> {
	const rows = await sql<{ table_name: string }[]>`
		select c.relname as table_name
		from pg_class c
		join pg_namespace n on n.oid = c.relnamespace
		join pg_attribute a on a.attrelid = c.oid and a.attname = 'organization_id' and not a.attisdropped
		where n.nspname = 'app' and c.relkind in ('r', 'p') and not c.relispartition
		order by 1`;
	return rows.map((row) => row.table_name);
}

async function countRows(sql: Executor, organizationId: string): Promise<Record<string, number>> {
	const counts: Record<string, number> = {};
	for (const table of await organizationTables(sql)) {
		const [row] = await sql<{ n: number }[]>`select count(*)::int as n from app.${sql(table)} where organization_id = ${organizationId}`;
		if (row && row.n > 0) counts[table] = row.n;
	}
	return counts;
}

async function productionPaymentIntegrations(sql: Executor, organizationId: string): Promise<number> {
	const [row] = await sql<{ n: number }[]>`
		select count(*)::int as n from app.organization_integrations
		where organization_id = ${organizationId} and provider = 'mercadopago' and mode = 'production'`;
	return row?.n ?? 0;
}

/**
 * Foreign keys are not checked while triggers are off. Tenant isolation means no
 * other organization references these rows; this proves it before the commit.
 */
async function danglingReferences(sql: Executor): Promise<string[]> {
	const constraints = await sql<{ name: string; child: string; parent: string; child_cols: string[]; parent_cols: string[] }[]>`
		select c.conname as name, c.conrelid::regclass::text as child, c.confrelid::regclass::text as parent,
			array(select a.attname::text from unnest(c.conkey) with ordinality k(attnum, ord)
				join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum order by k.ord) as child_cols,
			array(select a.attname::text from unnest(c.confkey) with ordinality k(attnum, ord)
				join pg_attribute a on a.attrelid = c.confrelid and a.attnum = k.attnum order by k.ord) as parent_cols
		from pg_constraint c
		where c.contype = 'f' and c.connamespace = 'app'::regnamespace`;
	const dangling: string[] = [];
	for (const fk of constraints) {
		const present = fk.child_cols.map((col) => `c.${quoteIdent(col)} is not null`).join(' and ');
		const matches = fk.child_cols.map((col, i) => `p.${quoteIdent(fk.parent_cols[i]!)} = c.${quoteIdent(col)}`).join(' and ');
		// Table names come from regclass, which already quotes them.
		const [row] = await sql.unsafe<{ found: boolean }[]>(
			`select exists (select 1 from ${fk.child} c where ${present} and not exists (select 1 from ${fk.parent} p where ${matches})) as found`
		);
		if (row?.found) dangling.push(fk.name);
	}
	return dangling;
}

function quoteIdent(name: string): string {
	return `"${name.replaceAll('"', '""')}"`;
}

async function countObjects(storage: OrganizationStorage, organizationId: string): Promise<Record<string, number>> {
	const counts: Record<string, number> = {};
	for (const bucket of storage.buckets) {
		counts[bucket] = (await storage.list(bucket, `${organizationId}/`)).length;
	}
	return counts;
}

/** Listed again after the commit, so files uploaded meanwhile go too. */
async function removeObjects(storage: OrganizationStorage, organizationId: string) {
	const storageRemoved: Record<string, number> = {};
	const storageErrors: string[] = [];
	for (const bucket of storage.buckets) {
		try {
			const paths = await storage.list(bucket, `${organizationId}/`);
			for (let i = 0; i < paths.length; i += REMOVE_BATCH) {
				await storage.remove(bucket, paths.slice(i, i + REMOVE_BATCH));
			}
			storageRemoved[bucket] = paths.length;
		} catch (error) {
			storageErrors.push(`${bucket}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return { storageRemoved, storageErrors };
}
