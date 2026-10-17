import { describe, expect, it } from 'vitest';
import { createResendProvider, PermanentDeliveryError, type OutgoingEmail } from '../src/notifications';

// The Resend provider (FR-NOTIF-01): one platform account sends every email.
// A retry must never send a second copy, and a message Resend refuses for
// good must not be retried for hours.

const message: OutgoingEmail = {
	from: 'MotoGarage <no-reply@sortea.test>',
	to: 'juana@example.com',
	subject: 'Compra confirmada MG-0001',
	html: '<p>Hola</p>',
	text: 'Hola',
	idempotencyKey: 'outbox:7d1c'
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
			from: 'MotoGarage <no-reply@sortea.test>',
			to: ['juana@example.com'],
			subject: 'Compra confirmada MG-0001',
			html: '<p>Hola</p>',
			text: 'Hola'
		});
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
