import type { DatabaseHandle } from '@sortea/db';
import type { KeyRing } from '@sortea/domain/server';
import type { ApiConfig } from './config';
import type { AdminTokenVerifier } from './lib/admin-auth';
import type { PaymentProvider } from './payments/provider';
import type { PaymentSimulator } from './payments/simulator';

/** Signed, short-lived access to private files (product PDFs). */
export interface FileStorage {
	signedUrl(path: string, expiresInSeconds: number, downloadName: string): Promise<string>;
}

/** Public bucket for site images (FR-CMS-04). Paths are content-addressed under the organization. */
export interface MediaStorage {
	upload(path: string, bytes: Uint8Array, contentType: string): Promise<void>;
	remove(path: string): Promise<void>;
	publicUrl(path: string): string;
}

export interface AppDeps {
	readonly config: Pick<
		ApiConfig,
		| 'NODE_ENV'
		| 'API_PUBLIC_URL'
		| 'WEB_FALLBACK_ORIGIN'
		| 'LOOKUP_PEPPER'
		| 'PSEUDONYM_PEPPER'
		| 'INTERNAL_API_TOKEN'
		| 'REQUIRE_ADMIN_MFA'
	>;
	readonly db: DatabaseHandle;
	readonly keyRing: KeyRing;
	readonly payments: PaymentProvider;
	/** Present only when the local simulator is enabled. */
	readonly simulator: PaymentSimulator | null;
	readonly storage: FileStorage;
	readonly media: MediaStorage;
	readonly verifyAdminToken: AdminTokenVerifier;
	readonly now: () => Date;
}
