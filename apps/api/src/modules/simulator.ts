import { eq, schema as s } from '@sortea/db';
import { signWebhook } from '@sortea/domain/server';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ApiError, parse } from '../lib/errors';
import { requireTenant } from '../lib/tenant';
import { loadMercadoPagoAccounts } from '../payments/integrations';
import type { PaymentSimulator } from '../payments/simulator';

const paySchema = z.object({ preferenceId: z.string().min(1), outcome: z.enum(['approved', 'rejected', 'in_process']) });
const statusSchema = z.object({ reference: z.string().min(1), status: z.enum(['refunded', 'charged_back']) });

/**
 * Drives the local payment simulator. Registered only when
 * PAYMENTS_FAKE_PROVIDER=true outside production. After "paying", it sends a
 * properly signed notification to the real webhook route, signed with the
 * secret of the account the order was created with (S2).
 */
export async function simulatorRoutes(app: FastifyInstance, simulator: PaymentSimulator) {
	const { deps } = app;

	async function notify(organizationId: string, orderReference: string, paymentId: string) {
		const integration = await deps.db.withTenant(organizationId, async (tx) => {
			const [order] = await tx
				.select({ integrationId: s.orders.paymentIntegrationId })
				.from(s.orders)
				.where(eq(s.orders.reference, orderReference));
			const accounts = await loadMercadoPagoAccounts(tx, organizationId, deps.keyRing);
			// Orders created before accounts were recorded use the active account.
			return accounts.find((account) => account.id === order?.integrationId) ?? accounts.find((account) => account.isActive);
		});
		if (!integration) throw new ApiError(503, 'payments_unavailable', 'Sin integración de pagos');
		const requestId = randomUUID();
		const ts = String(Math.floor(deps.now().getTime() / 1000));
		const v1 = signWebhook(integration.credentials.webhookSecret, paymentId, requestId, ts);
		const response = await app.inject({
			method: 'POST',
			url: `/webhooks/mercadopago/${organizationId}?data.id=${paymentId}&type=payment`,
			headers: { 'x-signature': `ts=${ts},v1=${v1}`, 'x-request-id': requestId },
			payload: { type: 'payment', action: 'payment.updated', data: { id: paymentId } }
		});
		return response.statusCode;
	}

	app.get('/dev/simulator/preferences/:id', async (request) => {
		const tenant = await requireTenant(request);
		const preference = simulator.preferences.get((request.params as { id: string }).id);
		if (!preference) throw new ApiError(404, 'not_found', 'Pago simulado no encontrado');
		const [order] = await deps.db.withTenant(tenant.id, (tx) =>
			tx.select({ reference: s.orders.reference }).from(s.orders).where(eq(s.orders.reference, preference.request.orderReference))
		);
		if (!order) throw new ApiError(404, 'not_found', 'Pago simulado no encontrado');
		return {
			id: preference.id,
			reference: preference.request.orderReference,
			items: preference.request.items,
			totalMinor: preference.request.items.reduce((sum, item) => sum + item.unitPriceMinor * item.quantity, 0),
			returnUrl: preference.request.backUrls.success
		};
	});

	app.post('/dev/simulator/pay', async (request) => {
		const tenant = await requireTenant(request);
		const body = parse(paySchema, request.body);
		const preference = simulator.preferences.get(body.preferenceId);
		if (!preference) throw new ApiError(404, 'not_found', 'Pago simulado no encontrado');
		const payment = simulator.pay(body.preferenceId, body.outcome);
		const webhookStatus = await notify(tenant.id, preference.request.orderReference, payment.id);
		return { paymentId: payment.id, webhookStatus, returnUrl: preference.request.backUrls.success };
	});

	app.post('/dev/simulator/payment-status', async (request) => {
		const tenant = await requireTenant(request);
		const body = parse(statusSchema, request.body);
		const [payment] = await deps.db.withTenant(tenant.id, (tx) =>
			tx
				.select({ id: s.payments.providerPaymentId })
				.from(s.payments)
				.innerJoin(s.orders, eq(s.orders.id, s.payments.orderId))
				.where(eq(s.orders.reference, body.reference))
		);
		if (!payment) throw new ApiError(404, 'not_found', 'Pago no encontrado');
		simulator.setStatus(payment.id, body.status);
		return { webhookStatus: await notify(tenant.id, body.reference, payment.id) };
	});
}
