import { createClient } from '@supabase/supabase-js';

/**
 * Back-office users and storage buckets of the environment at SUPABASE_URL,
 * shared by the seed and `pnpm client:load`.
 */
export function supabaseAdmin(url: string, secretKey: string) {
	const supabase = createClient(url, secretKey, { auth: { persistSession: false, autoRefreshToken: false } });

	return {
		host: new URL(url).host,

		/**
		 * Finds or creates the user with this email. `resetPassword` also sets the
		 * password of an existing user, as the seed does for its local accounts.
		 */
		async ensureUser(email: string, password: string, options: { resetPassword: boolean }): Promise<{ id: string; created: boolean }> {
			const { data: list, error: listError } = await supabase.auth.admin.listUsers({ perPage: 200 });
			if (listError) throw listError;
			const found = list.users.find((user) => user.email === email);
			if (found) {
				if (options.resetPassword) {
					const { error } = await supabase.auth.admin.updateUserById(found.id, { password });
					if (error) throw error;
				}
				return { id: found.id, created: false };
			}
			const { data, error } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
			if (error) throw error;
			return { id: data.user.id, created: true };
		},

		async upload(bucket: string, path: string, bytes: Uint8Array, contentType: string): Promise<void> {
			const { error } = await supabase.storage.from(bucket).upload(path, bytes, { contentType, upsert: true });
			if (error) throw new Error(`Upload failed for ${path}: ${error.message}`);
		},

		/** Creates the bucket, or updates an existing one, so older local databases get new limits without a reset. */
		async ensureBucket(bucket: string, options: { public: boolean; fileSizeLimit: number; allowedMimeTypes: string[] }): Promise<void> {
			const { data } = await supabase.storage.getBucket(bucket);
			const { error } = data ? await supabase.storage.updateBucket(bucket, options) : await supabase.storage.createBucket(bucket, options);
			if (error) throw new Error(`Could not set up bucket ${bucket}: ${error.message}`);
		}
	};
}
