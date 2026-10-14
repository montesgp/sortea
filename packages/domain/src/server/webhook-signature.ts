import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Mercado Pago webhook signature (FR-PAY-02), per the official manual
 * validation: HMAC-SHA256 over `id:<data.id>;request-id:<x-request-id>;ts:<ts>;`.
 *
 * A valid signature only proves origin. The payload is still not trusted: the
 * payment is always re-read from the provider API before any state change, so
 * a replayed notification can at most trigger an idempotent re-check.
 */
export type SignatureCheck =
	| { valid: true; timestamp: number }
	| { valid: false; reason: 'missing_header' | 'malformed_header' | 'bad_signature' | 'stale' };

export function parseSignatureHeader(header: string): { ts: string; v1: string } | null {
	let ts: string | undefined;
	let v1: string | undefined;
	for (const part of header.split(',')) {
		const eq = part.indexOf('=');
		if (eq === -1) continue;
		const key = part.slice(0, eq).trim();
		const value = part.slice(eq + 1).trim();
		if (key === 'ts') ts = value;
		if (key === 'v1') v1 = value;
	}
	return ts && v1 ? { ts, v1 } : null;
}

export function buildSignatureManifest(dataId: string, requestId: string, ts: string): string {
	const parts: string[] = [];
	if (dataId) parts.push(`id:${dataId.toLowerCase()}`);
	if (requestId) parts.push(`request-id:${requestId}`);
	parts.push(`ts:${ts}`);
	return parts.join(';') + ';';
}

export function signWebhook(secret: string, dataId: string, requestId: string, ts: string): string {
	return createHmac('sha256', secret).update(buildSignatureManifest(dataId, requestId, ts)).digest('hex');
}

export function verifyMercadoPagoSignature(input: {
	secret: string;
	signatureHeader: string | undefined;
	requestId: string | undefined;
	dataId: string;
	now?: Date;
	/** Optional freshness window; disabled by default because MP retries may resend old timestamps. */
	maxAgeSeconds?: number;
}): SignatureCheck {
	if (!input.signatureHeader) return { valid: false, reason: 'missing_header' };
	const parsed = parseSignatureHeader(input.signatureHeader);
	if (!parsed || !/^[0-9a-f]{64}$/i.test(parsed.v1)) return { valid: false, reason: 'malformed_header' };

	const expected = Buffer.from(signWebhook(input.secret, input.dataId, input.requestId ?? '', parsed.ts), 'hex');
	const received = Buffer.from(parsed.v1, 'hex');
	if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
		return { valid: false, reason: 'bad_signature' };
	}

	const raw = Number(parsed.ts);
	const timestampSeconds = raw > 1e12 ? Math.floor(raw / 1000) : raw;
	if (input.maxAgeSeconds !== undefined) {
		const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1000);
		if (Math.abs(nowSeconds - timestampSeconds) > input.maxAgeSeconds) return { valid: false, reason: 'stale' };
	}
	return { valid: true, timestamp: timestampSeconds };
}
