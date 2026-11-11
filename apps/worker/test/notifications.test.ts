import nodemailer from 'nodemailer';
import { describe, expect, it } from 'vitest';
import { createResendProvider, createSmtpProvider, PermanentDeliveryError, type OutgoingEmail } from '../src/notifications';

// The Resend provider (FR-NOTIF-01): one platform account sends every email.
// A retry must never send a second copy, and a message Resend refuses for
// good must not be retried for hours.

const message: OutgoingEmail = {
	from: 'Taller Demo <no-reply@sortea.test>',
	to: 'juana@example.com',
	subject: 'Compra confirmada MG-0001',
	html: '<p>Hola</p>',
	text: 'Hola',
	idempotencyKey: 'outbox:7d1c'
};

// A PNG signature stands in for the ticket: the providers only carry the bytes.
const ticketBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const withTicket: OutgoingEmail = {
	...message,
	html: '<p>Hola</p><img src="cid:ticket-1@sortea" alt="Ticket">',
	attachments: [
		{ filename: 'chances-MG-0001.png', contentType: 'image/png', content: ticketBytes },
		{ filename: 'chances-MG-0001.png', contentType: 'image/png', content: ticketBytes, inlineId: 'ticket-1@sortea' }
	]
};

function fakeFetch(status: number, body: unknown) {
	const calls: { url: string; init: RequestInit }[] = [];
	const fetchImpl = (async (url: string, init: RequestInit) => {
		calls.push({ url, init });
		return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
	}) as unknown as typeof fetch;
	return { calls, fetchImpl };
}

describe('Resend provider', () => {
	it('posts the email with the API key and the idempotency key, and returns the Resend id', async () => {
		const { calls, fetchImpl } = fakeFetch(200, { id: 're_123' });
		expect(await createResendProvider('re_key', fetchImpl).send(message)).toEqual({ messageId: 're_123' });
		expect(calls).toHaveLength(1);
		expect(calls[0]!.url).toBe('https://api.resend.com/emails');
		expect(calls[0]!.init.method).toBe('POST');
		expect(calls[0]!.init.headers).toMatchObject({ authorization: 'Bearer re_key', 'content-type': 'application/json', 'idempotency-key': 'outbox:7d1c' });
		expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
			from: 'Taller Demo <no-reply@sortea.test>',
			to: ['juana@example.com'],
			subject: 'Compra confirmada MG-0001',
			html: '<p>Hola</p>',
			text: 'Hola'
		});
	});

	it('sends the ticket as a download and as the image the body shows, keeping the idempotency key (S9)', async () => {
		const { calls, fetchImpl } = fakeFetch(200, { id: 're_124' });
		await createResendProvider('re_key', fetchImpl).send(withTicket);
		expect(calls[0]!.init.headers).toMatchObject({ 'idempotency-key': 'outbox:7d1c' });
		expect(JSON.parse(calls[0]!.init.body as string).attachments).toEqual([
			{ filename: 'chances-MG-0001.png', content: Buffer.from(ticketBytes).toString('base64'), content_type: 'image/png' },
			{ filename: 'chances-MG-0001.png', content: Buffer.from(ticketBytes).toString('base64'), content_type: 'image/png', content_id: 'ticket-1@sortea' }
		]);
	});

	it('sends no attachments field for an email without them', async () => {
		const { calls, fetchImpl } = fakeFetch(200, { id: 're_125' });
		await createResendProvider('re_key', fetchImpl).send(message);
		expect(JSON.parse(calls[0]!.init.body as string)).not.toHaveProperty('attachments');
	});

	it('treats a refused message as permanent and says why, without the email body', async () => {
		for (const status of [400, 401, 403, 422]) {
			const { fetchImpl } = fakeFetch(status, { name: 'validation_error', message: 'Invalid `to` field.' });
			const failure = await createResendProvider('re_key', fetchImpl)
				.send(message)
				.catch((error: unknown) => error);
			expect(failure, String(status)).toBeInstanceOf(PermanentDeliveryError);
			expect((failure as Error).message).toBe(`Resend rejected the email (${status}): Invalid \`to\` field.`);
		}
	});

	it('leaves rate limits, conflicts and server errors to the retry schedule', async () => {
		for (const status of [409, 429, 500, 503]) {
			const { fetchImpl } = fakeFetch(status, { message: 'try later' });
			const failure = await createResendProvider('re_key', fetchImpl)
				.send(message)
				.catch((error: unknown) => error);
			expect(failure, String(status)).toBeInstanceOf(Error);
			expect(failure, String(status)).not.toBeInstanceOf(PermanentDeliveryError);
			expect((failure as Error).message).toBe(`Resend responded ${status}: try later`);
		}
	});
});

// Local development sends through Mailpit; the ticket must reach it the same way (S9).
describe('SMTP provider', () => {
	const stream = () => nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' });

	it('sends the ticket as an attachment and as the inline image the body references', async () => {
		let raw = '';
		const transport = stream();
		const provider = createSmtpProvider('127.0.0.1', 1, {
			sendMail: async (mail) => {
				const info = await transport.sendMail(mail);
				raw = (info.message as Buffer).toString('utf8');
				return info;
			}
		});
		await provider.send(withTicket);
		const parts = raw.split(/^----_NmP-[^\n]*$/m).filter((part) => part.includes('Content-Type: image/png'));
		expect(parts).toHaveLength(2);
		const download = parts.find((part) => !part.includes('Content-ID'))!;
		const inline = parts.find((part) => part.includes('Content-ID'))!;
		expect(download).toMatch(/Content-Type: image\/png; name=chances-MG-0001\.png/);
		expect(download).toMatch(/Content-Disposition: attachment; filename=chances-MG-0001\.png/);
		expect(inline).toContain('Content-ID: <ticket-1@sortea>');
		expect(inline).toMatch(/Content-Disposition: inline; filename=chances-MG-0001\.png/);
		expect(download).toContain(Buffer.from(ticketBytes).toString('base64'));
		expect(raw).toContain('cid:ticket-1@sortea');
	});

	it('sends a plain email without attachments as before', async () => {
		let mail: Record<string, unknown> = {};
		const provider = createSmtpProvider('127.0.0.1', 1, {
			sendMail: async (sent) => {
				mail = sent as Record<string, unknown>;
				return { messageId: '<m1@test>' } as never;
			}
		});
		expect(await provider.send(message)).toEqual({ messageId: '<m1@test>' });
		expect(mail).toEqual({ from: message.from, to: message.to, subject: message.subject, html: message.html, text: message.text });
	});
});
