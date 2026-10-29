import { eq, schema as s } from '@sortea/db';
import { verifyMercadoPagoSignature, type SignatureCheck } from '@sortea/domain/server';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { applyVerifiedPayment } from '../payments/confirm';
import { loadMercadoPagoAccounts, type MercadoPagoAccount } from '../payments/integrations';
import { ProviderError, type ProviderPayment } from '../payments/provider';

const paramsSchema = z.object({ organizationId: z.uuid() });

/**
 * Public Mercado Pago notifications (FR-PAY-02). The path names the
 * organization so its secrets can be chosen; naming another tenant only makes
 * the signature check fail. The signature also tells which of the
 * organization's accounts can have sent it, the active one or a previous one.
 * The body is never trusted: the payment is re-read with the credentials of a
 * signing account that can read it, and must belong to an order created with
 * that account (S2).
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
		const { signers, signature } = signingAccounts(accounts, {
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

		if (!signature.valid || signers.length === 0) {
			await record('rejected_signature', signature.valid ? null : signature.reason);
			return reply.status(401).send({ error: { code: 'invalid_signature' } });
		}
		if (topic !== 'payment' || !dataId) {
			await record('ignored_topic');
			return reply.status(200).send({ ok: true });
		}

		// Accounts sharing a webhook secret all validate the signature: the payment
		// is read with each, its recorded order's account first, until one has it.
		let candidates = signers;
		if (signers.length > 1) {
			const [owner] = await deps.db.withTenant(organizationId, (tx) =>
				tx
					.select({ integrationId: s.orders.paymentIntegrationId })
					.from(s.payments)
					.innerJoin(s.orders, eq(s.orders.id, s.payments.orderId))
					.where(eq(s.payments.providerPaymentId, dataId))
					.limit(1)
			);
			const preferred = owner?.integrationId;
			if (preferred) candidates = [...signers].sort((a, b) => Number(b.id === preferred) - Number(a.id === preferred));
		}

		// A failure of one account does not end the search (S7): another signing
		// account may still have the payment.
		let found: { account: MercadoPagoAccount; payment: ProviderPayment } | null = null;
		let failure: unknown = null;
		for (const candidate of candidates) {
			try {
				found = { account: candidate, payment: await deps.payments.getPayment(candidate.credentials, dataId) };
				break;
			} catch (error) {
				if (error instanceof ProviderError && error.status === 404) continue;
				failure ??= error;
			}
		}
		if (!found && failure) {
			await record('provider_error', failure instanceof Error ? failure.message : 'unknown');
			// Non-2xx makes Mercado Pago retry later.
			return reply.status(503).send({ error: { code: 'provider_unavailable' } });
		}
		if (!found) {
			await record('payment_not_found');
			return reply.status(200).send({ ok: true });
		}
		const { account, payment } = found;

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
 * The accounts whose secret validates the notification, the active account
 * first. Every account is checked, each comparison timing-safe; when none
 * matches, the active account's check says why.
 */
function signingAccounts(
	accounts: readonly MercadoPagoAccount[],
	input: { signatureHeader: string | undefined; requestId: string | undefined; dataId: string }
): { signers: MercadoPagoAccount[]; signature: SignatureCheck } {
	const signers: MercadoPagoAccount[] = [];
	let valid: SignatureCheck | null = null;
	let first: SignatureCheck | null = null;
	for (const account of accounts) {
		const signature = verifyMercadoPagoSignature({ secret: account.credentials.webhookSecret, ...input });
		if (signature.valid) {
			signers.push(account);
			valid ??= signature;
		}
		first ??= signature;
	}
	return { signers, signature: valid ?? first! };
}

function headerValue(value: string | string[] | undefined): string | undefined {
	return Array.isArray(value) ? value[0] : value;
}
