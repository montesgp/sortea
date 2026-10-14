import { createClient } from '@supabase/supabase-js';
import type { FileStorage } from './context';

/** Private Supabase Storage bucket; the secret key never leaves the API. */
export function createSupabaseStorage(url: string, secretKey: string, bucket: string): FileStorage {
	const client = createClient(url, secretKey, { auth: { persistSession: false, autoRefreshToken: false } });
	return {
		async signedUrl(path, expiresInSeconds, downloadName) {
			const { data, error } = await client.storage.from(bucket).createSignedUrl(path, expiresInSeconds, { download: downloadName });
			if (error || !data) throw new Error(`Could not sign storage URL: ${error?.message ?? 'unknown'}`);
			return data.signedUrl;
		}
	};
}
