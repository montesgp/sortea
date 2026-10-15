import { createClient } from '@supabase/supabase-js';
import type { FileStorage, MediaStorage } from './context';

function client(url: string, secretKey: string) {
	return createClient(url, secretKey, { auth: { persistSession: false, autoRefreshToken: false } });
}

/** Private Supabase Storage bucket; the secret key never leaves the API. */
export function createSupabaseStorage(url: string, secretKey: string, bucket: string): FileStorage {
	const storage = client(url, secretKey).storage.from(bucket);
	return {
		async signedUrl(path, expiresInSeconds, downloadName) {
			const { data, error } = await storage.createSignedUrl(path, expiresInSeconds, { download: downloadName });
			if (error || !data) throw new Error(`Could not sign storage URL: ${error?.message ?? 'unknown'}`);
			return data.signedUrl;
		}
	};
}

/**
 * Public bucket for site images. Only the API writes to it; objects are named
 * by their hash, so they can be cached forever.
 */
export function createSupabaseMediaStorage(url: string, secretKey: string, bucket: string): MediaStorage {
	const storage = client(url, secretKey).storage.from(bucket);
	return {
		async upload(path, bytes, contentType) {
			const { error } = await storage.upload(path, bytes, { contentType, upsert: true, cacheControl: '31536000' });
			if (error) throw new Error(`Could not upload media: ${error.message}`);
		},
		async remove(path) {
			const { error } = await storage.remove([path]);
			if (error) throw new Error(`Could not remove media: ${error.message}`);
		},
		publicUrl(path) {
			return storage.getPublicUrl(path).data.publicUrl;
		}
	};
}
