import { eq, schema as s } from '@sortea/db';
import { verifyMercadoPagoSignature, type SignatureCheck } from '@sortea/domain/server';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { applyVerifiedPayment, type ConfirmationOutcome } from '../payments/confirm';
import { loadMercadoPagoAccounts, type MercadoPagoAccount } from '../payments/integrations';
import { ProviderError, type ProviderPayment } from '../payments/provider';

/** Outcomes of a read order that does not match a platform order: logged at warn, the others at info. */
const MISMATCHES = new Set<ConfirmationOutcome>([
	'unknown_order',
	'reference_mismatch',
	'amount_mismatch',
	'currency_mismatch',
	'merchant_mismatch',
	'payment_order_mismatch'
]);

const paramsSchema = z.object({ organizationId: z.uuid() });

/**
 * Public Mercado Pago notifications (FR-PAY-02). The path names the
 * organization so its secrets can be chosen; naming another tenant only makes
 * the signature check fail. The signature also tells which of the
 * organization's accounts can have sent it, the active one or a previous one.
 *
 * Checkout Pro runs through the Orders API (ADR 0018): only `order`
 * notifications (`data.id` = `ORD...`, lowercased in the signed manifest) are
 * acted on. Other topics (`payment`, `merchant_order`, ...) answer 200 and
 * change nothing, so Mercado Pago stops retrying them. The body is never
 * trusted: the order is re-read with the credentials of a signing account that
 * can read it, and must belong to a platform order created with that account (S2).
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

		// Service logs (S9, owner-feedback-2026-11-11b) carry ids, the topic and the reason only:
		// never the signature, a secret or token, nor any buyer data.
		const facts = { organizationId, topic, dataId, requestId };
		const rejected = (outcome: string, reason: string | null = null) => request.log.warn({ ...facts, outcome, reason }, 'mercadopago webhook rejected');

		const [organization] = await deps.db.withPlatform((db) =>
			db.select({ id: s.organizations.id }).from(s.organizations).where(eq(s.organizations.id, organizationId))
		);
		if (!organization) {
			rejected('unknown_organization');
			return reply.status(404).send();
		}

		const accounts = await deps.db.withTenant(organizationId, (tx) => loadMercadoPagoAccounts(tx, organizationId, deps.keyRing));
		if (accounts.length === 0) {
			rejected('no_payment_account');
			return reply.status(404).send();
		}
		const { signers, signature } = signingAccounts(accounts, {
			signatureHeader: headerValue(request.headers['x-signature']),
			requestId,
			dataId
		});

		// The account whose secret validated the signature, the principal first; null when none did.
		// Once the payment is read, the account that had it (S6, console-polish-2026-11-11).
		const record = (outcome: string, detail: string | null = null, integrationId: string | null = signers[0]?.id ?? null) =>
			deps.db.withTenant(organizationId, (tx) =>
				tx.insert(s.paymentEvents).values({
					organizationId,
					provider: 'mercadopago',
					requestId: requestId ?? null,
					topic,
					providerPaymentId: dataId || null,
					signatureValid: signature.valid,
					integrationId,
					outcome,
					detail
				})
			);

		// Nothing but an order notification changes state, signed or not.
		if (topic !== 'order' || !dataId) {
			await record('ignored_topic');
			return reply.status(200).send({ ok: true });
		}
		if (!signature.valid || signers.length === 0) {
			await record('rejected_signature', signature.valid ? null : signature.reason);
			rejected('rejected_signature', signature.valid ? null : signature.reason);
			return reply.status(401).send({ error: { code: 'invalid_signature' } });
		}

		// Accounts sharing a webhook secret all validate the signature: the order
		// is read with each, the account of its recorded payment first, until one has it.
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
		// account may still have the order.
		let found: { account: MercadoPagoAccount; payment: ProviderPayment } | null = null;
		let failure: unknown = null;
		for (const candidate of candidates) {
			try {
				found = { account: candidate, payment: await deps.payments.getOrder(candidate.credentials, dataId) };
				break;
			} catch (error) {
				if (error instanceof ProviderError && error.status === 404) continue;
				failure ??= error;
			}
		}
		if (!found && failure) {
			const reason = failure instanceof Error ? failure.message : 'unknown';
			await record('provider_error', reason);
			rejected('provider_error', reason);
			// Non-2xx makes Mercado Pago retry later.
			return reply.status(503).send({ error: { code: 'provider_unavailable' } });
		}
		if (!found) {
			await record('payment_not_found');
			rejected('payment_not_found');
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
		await record(outcome, null, account.id);
		const applied = { ...facts, outcome, orderReference: payment.externalReference, integrationId: account.id };
		if (MISMATCHES.has(outcome)) request.log.warn(applied, 'mercadopago webhook rejected');
		else request.log.info(applied, 'mercadopago webhook applied');
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
