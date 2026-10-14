import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Envelope for tenant integration secrets (FR-ORG-02). AES-256-GCM with a
 * versioned key ring so keys can rotate: `v<keyVersion>.<iv>.<tag>.<data>`.
 * The ciphertext is bound to its owner (organization + integration) through
 * GCM additional data, so a secret copied to another tenant fails to decrypt.
 */
export interface KeyRing {
	readonly current: number;
	readonly keys: ReadonlyMap<number, Buffer>;
}

export function parseKeyRing(spec: string): KeyRing {
	const keys = new Map<number, Buffer>();
	for (const part of spec.split(',').map((value) => value.trim()).filter(Boolean)) {
		const match = /^v(\d+):(.+)$/.exec(part);
		if (!match) throw new Error('Key ring entries must look like v1:<base64 key>');
		const key = Buffer.from(match[2]!, 'base64');
		if (key.length !== 32) throw new Error(`Key v${match[1]} must be 32 bytes`);
		keys.set(Number(match[1]), key);
	}
	if (keys.size === 0) throw new Error('Key ring is empty');
	return { current: Math.max(...keys.keys()), keys };
}

export function sealSecret(ring: KeyRing, plaintext: string, owner: string): string {
	const key = ring.keys.get(ring.current)!;
	const iv = randomBytes(12);
	const cipher = createCipheriv('aes-256-gcm', key, iv);
	cipher.setAAD(Buffer.from(owner));
	const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
	return ['v' + ring.current, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), data.toString('base64url')].join('.');
}

export function openSecret(ring: KeyRing, sealed: string, owner: string): string {
	const [version, iv, tag, data] = sealed.split('.');
	const key = ring.keys.get(Number(version?.slice(1)));
	if (!key || !iv || !tag || !data) throw new Error('Unreadable sealed secret');
	const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
	decipher.setAAD(Buffer.from(owner));
	decipher.setAuthTag(Buffer.from(tag, 'base64url'));
	return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
}

export function sealedKeyVersion(sealed: string): number {
	return Number(sealed.split('.')[0]?.slice(1));
}

/** `APP_USR-…1234`: enough for an operator to recognise a credential, never enough to use it. */
export function maskSecret(value: string): string {
	if (value.length <= 8) return '••••';
	return `${value.slice(0, 4)}••••${value.slice(-4)}`;
}
