import { serializeManifest, type CanonicalManifest } from '../manifest';
import { sha256Hex } from './tokens';

export * from './secrets';
export * from './tokens';
export * from './webhook-signature';

export function hashManifest(manifest: CanonicalManifest): string {
	return sha256Hex(serializeManifest(manifest));
}

/** Recomputes the hash of a published manifest file and compares it with the commitment (AC-11). */
export function verifyManifestHash(manifestText: string, publishedHash: string): boolean {
	return sha256Hex(manifestText) === publishedHash.toLowerCase();
}
