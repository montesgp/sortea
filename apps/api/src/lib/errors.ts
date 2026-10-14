import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

export class ApiError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
		readonly details?: unknown
	) {
		super(message);
	}
}

export const notFound = (what = 'Recurso') => new ApiError(404, 'not_found', `${what} no encontrado`);
export const forbidden = (message = 'No tenés permiso para esta acción') => new ApiError(403, 'forbidden', message);

export function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
	const result = schema.safeParse(value);
	if (!result.success) {
		throw new ApiError(400, 'invalid_request', 'Revisá los datos enviados', z.flattenError(result.error));
	}
	return result.data;
}

export function errorHandler(error: FastifyError | ApiError, request: FastifyRequest, reply: FastifyReply) {
	if (error instanceof ApiError) {
		return reply.status(error.status).send({ error: { code: error.code, message: error.message, details: error.details } });
	}
	if (error.statusCode === 429) {
		return reply.status(429).send({ error: { code: 'rate_limited', message: 'Demasiados intentos. Esperá unos minutos.' } });
	}
	if (error.statusCode && error.statusCode < 500) {
		return reply.status(error.statusCode).send({ error: { code: 'bad_request', message: error.message } });
	}
	// Never echo internals: the log keeps the stack, the client gets a stable code.
	request.log.error({ err: error }, 'unhandled error');
	return reply.status(500).send({ error: { code: 'internal', message: 'Ocurrió un error inesperado' } });
}
