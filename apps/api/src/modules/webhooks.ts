import { eq, schema as s } from '@sortea/db';
import { verifyMercadoPagoSignature } from '@sortea/domain/server';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { applyVerifiedPayment } from '../payments/confirm';
import { loadMercadoPago } from '../payments/integrations';
import { ProviderError } from '../payments/provider';

const paramsSchema = z.object({ organizationId: z.uuid() });

/**
 * Public Mercado Pago notifications (FR-PAY-02). The path names the
 * organization so the right secret can be chosen; naming another tenant only
 * makes the signature check fail. The body is never trusted: the payment is
 * re-read with that organization's own credentials.
 */
export async function webhookRoutes(app: FastifyInstance) {
	const { deps } = app;

	app.post('/webhooks/mercadopago/:organizationId', { config: { rateLimit: { max: 300, timeWindow: '1 minute' } } }, async (request, reply) => {
		const params = paramsSchema.safeParse(request.params);
		if (!params.success) return reply.status(404).send();
		const { organizationId } = params.data;

		const query = request.query as Record<string, string | undefined>;
		const body = (request.body ?? {}) as { type?: string; data?: { id?: string | number } };
		const topic = query.type ?? query.topic ?? body.type ?? 'unknown';
		const dataId = String(query['data.id'] ?? body.data?.id ?? query.id ?? '');
		const requestId = headerValue(request.headers['x-request-id']);

		const [organization] = await deps.db.withPlatform((db) =>
			db.select({ id: s.organizations.id }).from(s.organizations).where(eq(s.organizations.id, organizationId))
		);
		if (!organization) return reply.status(404).send();

		const integration = await deps.db.withTenant(organizationId, (tx) => loadMercadoPago(tx, organizationId, deps.keyRing));
		if (!integration) return reply.status(404).send();

		const signature = verifyMercadoPagoSignature({
			secret: integration.credentials.webhookSecret,
			signatureHeader: headerValue(request.headers['x-signature']),
			requestId,
			dataId
		});

		const record = (outcome: string, detail: string | null = null) =>
			deps.db.withTenant(organizationId, (tx) =>
				tx.insert(s.paymentEvents).values({
					organizationId,
					provider: 'mercadopago',
					requestId: requestId ?? null,
					topic,
					providerPaymentId: dataId || null,
					signatureValid: signature.valid,
					outcome,
					detail
				})
			);

		if (!signature.valid) {
			await record('rejected_signature', signature.reason);
			return reply.status(401).send({ error: { code: 'invalid_signature' } });
		}
		if (topic !== 'payment' || !dataId) {
			await record('ignored_topic');
			return reply.status(200).send({ ok: true });
		}

		let payment;
		try {
			payment = await deps.payments.getPayment(integration.credentials, dataId);
		} catch (error) {
			if (error instanceof ProviderError && error.status === 404) {
				await record('payment_not_found');
				return reply.status(200).send({ ok: true });
			}
			await record('provider_error', error instanceof Error ? error.message : 'unknown');
			// Non-2xx makes Mercado Pago retry later.
			return reply.status(503).send({ error: { code: 'provider_unavailable' } });
		}

		const outcome = await deps.db.withTenant(organizationId, (tx) =>
			applyVerifiedPayment(
				tx,
				{ organizationId, expectedCollectorId: integration.collectorId, pseudonymPepper: deps.config.PSEUDONYM_PEPPER, now: deps.now() },
				payment
			)
		);
		await record(outcome);
		return reply.status(200).send({ ok: true });
	});
}

function headerValue(value: string | string[] | undefined): string | undefined {
	return Array.isArray(value) ? value[0] : value;
}
