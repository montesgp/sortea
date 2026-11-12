import type { DatabaseHandle } from '@sortea/db';
import type { KeyRing } from '@sortea/domain/server';
import type { ApiConfig } from './config';
import type { PaymentProvider } from './payments/provider';
import type { PaymentSimulator } from './payments/simulator';

/** Signed, short-lived access to private files (the files digital products deliver). */
export interface FileStorage {
	signedUrl(path: string, expiresInSeconds: number, downloadName: string): Promise<string>;
	/** Puts a file the back office uploads behind a product (owner-feedback-2026-11-11b, S2). */
	upload(path: string, bytes: Uint8Array, contentType: string): Promise<void>;
	exists(path: string): Promise<boolean>;
	/** Deletes the files of a product removed from the catalog (S10), or a file replaced or removed. */
	remove(paths: string[]): Promise<void>;
}

/** Site images and videos (FR-CMS-04, ADR 0020). Paths are content-addressed under the organization. */
export interface MediaStorage {
	upload(path: string, bytes: Uint8Array, contentType: string): Promise<void>;
	remove(path: string): Promise<void>;
	/** The URL the site uses for the file. */
	publicUrl(path: string): string;
	/** A presigned URL of the file for the time window of `now`, and how long it may be cached. */
	signedUrl(path: string, now: Date): Promise<{ url: string; maxAgeSeconds: number }>;
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
		| 'COMPLIANCE_DEMO'
	>;
	readonly db: DatabaseHandle;
	readonly keyRing: KeyRing;
	readonly payments: PaymentProvider;
	/** Present only when the local simulator is enabled. */
	readonly simulator: PaymentSimulator | null;
	readonly storage: FileStorage;
	readonly media: MediaStorage;
	readonly now: () => Date;
	/** Waits before a replaced or removed product file is deleted from storage; tests pass one that does not. */
	readonly sleep?: (ms: number) => Promise<void>;
}
