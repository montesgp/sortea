import { eq, schema as s } from '@sortea/db';
import { verifyMercadoPagoSignature, type SignatureCheck } from '@sortea/domain/server';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { applyVerifiedPayment } from '../payments/confirm';
import { loadMercadoPagoAccounts, type MercadoPagoAccount } from '../payments/integrations';
import { ProviderError } from '../payments/provider';

const paramsSchema = z.object({ organizationId: z.uuid() });

/**
 * Public Mercado Pago notifications (FR-PAY-02). The path names the
 * organization so its secrets can be chosen; naming another tenant only makes
 * the signature check fail. The signature also tells which of the
 * organization's accounts sent it, the active one or a previous one. The body
 * is never trusted: the payment is re-read with that account's credentials and
 * must belong to an order created with that account (S2).
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

		const accounts = await deps.db.withTenant(organizationId, (tx) => loadMercadoPagoAccounts(tx, organizationId, deps.keyRing));
		if (accounts.length === 0) return reply.status(404).send();
		const { account, signature } = signingAccount(accounts, {
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

		if (!signature.valid || !account) {
			await record('rejected_signature', signature.valid ? null : signature.reason);
			return reply.status(401).send({ error: { code: 'invalid_signature' } });
		}
		if (topic !== 'payment' || !dataId) {
			await record('ignored_topic');
			return reply.status(200).send({ ok: true });
		}

		let payment;
		try {
			payment = await deps.payments.getPayment(account.credentials, dataId);
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
				{
					organizationId,
					paymentAccountId: account.id,
					expectedCollectorId: account.collectorId,
					pseudonymPepper: deps.config.PSEUDONYM_PEPPER,
					complianceDemo: deps.config.COMPLIANCE_DEMO,
					now: deps.now()
				},
				payment
			)
		);
		await record(outcome);
		return reply.status(200).send({ ok: true });
	});
}

/**
 * The account whose secret signed the notification, the active account first.
 * Each comparison is timing-safe; when none matches, the active account's
 * check says why.
 */
function signingAccount(
	accounts: readonly MercadoPagoAccount[],
	input: { signatureHeader: string | undefined; requestId: string | undefined; dataId: string }
): { account: MercadoPagoAccount | null; signature: SignatureCheck } {
	let first: SignatureCheck | null = null;
	for (const account of accounts) {
		const signature = verifyMercadoPagoSignature({ secret: account.credentials.webhookSecret, ...input });
		if (signature.valid) return { account, signature };
		first ??= signature;
	}
	return { account: null, signature: first! };
}

function headerValue(value: string | string[] | undefined): string | undefined {
	return Array.isArray(value) ? value[0] : value;
}
