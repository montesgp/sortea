import { sql } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

export type Database = PostgresJsDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
export type Executor = Database | Tx;

export interface DatabaseHandle {
	/**
	 * Runs `fn` in a transaction as the restricted `sortea_app` role with the
	 * organization pinned. Row level security makes rows of every other tenant
	 * invisible, even if a query forgets its `organization_id` filter.
	 */
	withTenant<T>(organizationId: string, fn: (tx: Tx) => Promise<T>): Promise<T>;
	/**
	 * Cross-tenant access with the owner role. Only for code paths that are
	 * platform-level by nature: hostname resolution, platform admin screens,
	 * the outbox claimer. Keep call sites few and named.
	 */
	withPlatform<T>(fn: (db: Database) => Promise<T>): Promise<T>;
	/**
	 * LISTEN on a dedicated connection that reconnects by itself. `onListen`
	 * runs on every (re)connect: notifications sent while disconnected are lost,
	 * so listeners use it to tell their clients to resync.
	 */
	listen(channel: string, onMessage: (payload: string) => void, onListen?: () => void): Promise<{ unlisten(): Promise<void> }>;
	close(): Promise<void>;
}

export function createDatabase(url: string, options: { max?: number } = {}): DatabaseHandle {
	const client = postgres(url, {
		max: options.max ?? 10,
		// Required by Supabase's transaction pooler; harmless on direct connections.
		prepare: false,
		onnotice: () => {}
	});
	const db = drizzle(client, { schema, casing: 'snake_case' });

	return {
		withTenant(organizationId, fn) {
			return db.transaction(async (tx) => {
				await tx.execute(sql`select set_config('app.organization_id', ${organizationId}, true)`);
				await tx.execute(sql`set local role sortea_app`);
				return fn(tx);
			});
		},
		withPlatform(fn) {
			return fn(db);
		},
		async listen(channel, onMessage, onListen) {
			const { unlisten } = await client.listen(channel, onMessage, onListen);
			return { unlisten };
		},
		close() {
			return client.end({ timeout: 5 });
		}
	};
}
