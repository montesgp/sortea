import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

export interface AdminIdentity {
	readonly userId: string;
	readonly email: string;
	/** Supabase authenticator assurance level: aal2 means MFA was completed. */
	readonly aal: 'aal1' | 'aal2';
}

export type AdminTokenVerifier = (token: string) => Promise<AdminIdentity | null>;

/** Verifies Supabase Auth access tokens against the project's published keys. */
export function createAdminTokenVerifier(options: { issuer: string; keys: JWTVerifyGetKey }): AdminTokenVerifier {
	return async (token) => {
		try {
			const { payload } = await jwtVerify(token, options.keys, { issuer: options.issuer, audience: 'authenticated' });
			if (typeof payload.sub !== 'string' || typeof payload.email !== 'string') return null;
			return { userId: payload.sub, email: payload.email, aal: payload.aal === 'aal2' ? 'aal2' : 'aal1' };
		} catch {
			return null;
		}
	};
}

export function supabaseTokenVerifier(supabaseUrl: string): AdminTokenVerifier {
	const issuer = `${supabaseUrl.replace(/\/$/, '')}/auth/v1`;
	return createAdminTokenVerifier({ issuer, keys: createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`)) });
}
