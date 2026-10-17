import nodemailer from 'nodemailer';

/**
 * Notification channel port (FR-NOTIF-02). Email today; WhatsApp Business
 * plugs in later as another provider without touching the outbox handlers.
 */
export interface OutgoingEmail {
	readonly from: string;
	readonly to: string;
	readonly subject: string;
	readonly html: string;
	readonly text: string;
	/** Same for every retry of one email, so a provider that honors it sends a single copy. */
	readonly idempotencyKey?: string;
}

/** The provider refused the message for good (bad address, sender or key): retrying cannot help. */
export class PermanentDeliveryError extends Error {
	override readonly name = 'PermanentDeliveryError';
}

export interface NotificationProvider {
	readonly name: string;
	send(message: OutgoingEmail): Promise<{ messageId: string }>;
}

/** Local development: delivers to Mailpit (http://127.0.0.1:54324). */
export function createSmtpProvider(host: string, port: number): NotificationProvider {
	const transport = nodemailer.createTransport({ host, port, secure: false, ignoreTLS: true });
	return {
		name: 'smtp',
		async send(message) {
			const info = await transport.sendMail(message);
			return { messageId: info.messageId };
		}
	};
}

/**
 * Production: one platform Resend account sends every organization's email.
 * Rate limits (429), idempotency conflicts (409) and server errors are
 * retried by the outbox; any other 4xx is permanent. Errors carry Resend's
 * reason, never the message body.
 */
export function createResendProvider(apiKey: string, fetchImpl: typeof fetch = fetch): NotificationProvider {
	return {
		name: 'resend',
		async send(message) {
			const headers: Record<string, string> = { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' };
			if (message.idempotencyKey) headers['idempotency-key'] = message.idempotencyKey;
			const response = await fetchImpl('https://api.resend.com/emails', {
				method: 'POST',
				headers,
				body: JSON.stringify({ from: message.from, to: [message.to], subject: message.subject, html: message.html, text: message.text }),
				signal: AbortSignal.timeout(10_000)
			});
			if (!response.ok) {
				const body = (await response.json().catch(() => null)) as { message?: unknown } | null;
				const reason = typeof body?.message === 'string' ? `: ${body.message.slice(0, 200)}` : '';
				const status = response.status;
				if (status >= 400 && status < 500 && status !== 409 && status !== 429) throw new PermanentDeliveryError(`Resend rejected the email (${status})${reason}`);
				throw new Error(`Resend responded ${status}${reason}`);
			}
			const body = (await response.json()) as { id: string };
			return { messageId: body.id };
		}
	};
}

/** Prints only metadata, never the body: bodies can contain codes and links. */
export function createLogProvider(log: (line: string) => void = console.log): NotificationProvider {
	return {
		name: 'log',
		async send(message) {
			log(`[email] to=${message.to.replace(/(.{2}).*@/, '$1***@')} subject="${message.subject}"`);
			return { messageId: `log-${Date.now()}` };
		}
	};
}
