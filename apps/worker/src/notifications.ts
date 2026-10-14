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

export function createResendProvider(apiKey: string, fetchImpl: typeof fetch = fetch): NotificationProvider {
	return {
		name: 'resend',
		async send(message) {
			const response = await fetchImpl('https://api.resend.com/emails', {
				method: 'POST',
				headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
				body: JSON.stringify({ from: message.from, to: [message.to], subject: message.subject, html: message.html, text: message.text }),
				signal: AbortSignal.timeout(10_000)
			});
			if (!response.ok) throw new Error(`Resend responded ${response.status}`);
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
