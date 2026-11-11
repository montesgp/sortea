import { and, desc, eq, schema as s, type Executor } from '@sortea/db';
import { openSecret, type KeyRing } from '@sortea/domain/server';
import { ApiError } from '../lib/errors';
import type { ProviderCredentials } from './provider';

export interface MercadoPagoAccount {
	readonly id: string;
	readonly mode: 'sandbox' | 'production';
	readonly credentials: ProviderCredentials;
	readonly collectorId: string | null;
	readonly simulator: boolean;
	/** False for a previous account, kept to verify the payments of its orders. */
	readonly isActive: boolean;
}

/** The account new orders are created with. */
export type ActiveIntegration = MercadoPagoAccount;

/**
 * What an account does for its organization (ADR 0017, amendment 2026-11-11):
 * the principal charges new purchases; the backup is connected and verified,
 * ready to take over, and is never charged until it becomes the principal; a
 * previous account was retired and only settles the purchases created with it.
 * At most one of each of the first two, kept under the organization row lock.
 */
export type AccountRole = 'principal' | 'backup' | 'previous';

export function accountRole(row: { readonly isActive: boolean; readonly retiredAt: Date | null }): AccountRole {
	if (row.isActive) return 'principal';
	return row.retiredAt === null ? 'backup' : 'previous';
}

export function integrationOwner(organizationId: string, integrationId: string): string {
	return `${organizationId}:${integrationId}`;
}

type IntegrationRow = typeof s.organizationIntegrations.$inferSelect;

function openAccount(organizationId: string, row: IntegrationRow, keyRing: KeyRing): MercadoPagoAccount {
	const secrets = JSON.parse(openSecret(keyRing, row.sealedSecrets, integrationOwner(organizationId, row.id))) as ProviderCredentials;
	return {
		id: row.id,
		mode: row.mode,
		credentials: { accessToken: secrets.accessToken, webhookSecret: secrets.webhookSecret },
		collectorId: row.publicConfig.collectorId ?? null,
		simulator: row.publicConfig.simulator === 'true',
		isActive: row.isActive
	};
}

/**
 * The organization's active Mercado Pago account. Secrets are opened only
 * here, inside the API, for the duration of a provider call.
 */
export async function loadMercadoPago(executor: Executor, organizationId: string, keyRing: KeyRing): Promise<ActiveIntegration | null> {
	const [row] = await executor
		.select()
		.from(s.organizationIntegrations)
		.where(
			and(
				eq(s.organizationIntegrations.organizationId, organizationId),
				eq(s.organizationIntegrations.provider, 'mercadopago'),
				eq(s.organizationIntegrations.isActive, true)
			)
		)
		.orderBy(desc(s.organizationIntegrations.updatedAt))
		.limit(1);
	return row ? openAccount(organizationId, row, keyRing) : null;
}

/**
 * Every Mercado Pago account of the organization: the active one first, then
 * the backup (never retired, so first among descending retirements), then the
 * previous ones, most recently retired first. Orders are confirmed and
 * reconciled with the account they were created with (S2).
 */
export async function loadMercadoPagoAccounts(executor: Executor, organizationId: string, keyRing: KeyRing): Promise<MercadoPagoAccount[]> {
	const rows = await executor
		.select()
		.from(s.organizationIntegrations)
		.where(and(eq(s.organizationIntegrations.organizationId, organizationId), eq(s.organizationIntegrations.provider, 'mercadopago')))
		.orderBy(desc(s.organizationIntegrations.isActive), desc(s.organizationIntegrations.retiredAt), desc(s.organizationIntegrations.updatedAt));
	return rows.map((row) => openAccount(organizationId, row, keyRing));
}

export async function requireMercadoPago(executor: Executor, organizationId: string, keyRing: KeyRing): Promise<ActiveIntegration> {
	const integration = await loadMercadoPago(executor, organizationId, keyRing);
	if (!integration) throw new ApiError(503, 'payments_unavailable', 'Los pagos todavía no están habilitados para este sitio');
	return integration;
}
