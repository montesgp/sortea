import { eq, schema as s } from '@sortea/db';
import { signWebhook } from '@sortea/domain/server';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ApiError, parse } from '../lib/errors';
import { requireTenant } from '../lib/tenant';
import { loadMercadoPagoAccounts } from '../payments/integrations';
import type { PaymentSimulator } from '../payments/simulator';

const paySchema = z.object({ orderId: z.string().min(1), outcome: z.enum(['approved', 'rejected', 'in_process']) });
const statusSchema = z.object({ reference: z.string().min(1), status: z.enum(['refunded', 'charged_back']) });

/**
 * Drives the local payment simulator. Registered only when
 * PAYMENTS_FAKE_PROVIDER=true outside production. After "paying", it sends an
 * order notification shaped like Mercado Pago's to the real webhook route,
 * signed with the secret of the account the order was created with (S2).
 */
export async function simulatorRoutes(app: FastifyInstance, simulator: PaymentSimulator) {
	const { deps } = app;

	async function notify(organizationId: string, orderReference: string, orderId: string, action: string) {
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
		const v1 = signWebhook(integration.credentials.webhookSecret, orderId, requestId, ts);
		const response = await app.inject({
			method: 'POST',
			url: `/webhooks/mercadopago/${organizationId}?data.id=${orderId}&type=order`,
			headers: { 'x-signature': `ts=${ts},v1=${v1}`, 'x-request-id': requestId },
			payload: { action, api_version: 'v1', type: 'order', live_mode: false, data: { id: orderId } }
		});
		return response.statusCode;
	}

	/** A simulated order of this organization, or 404. */
	async function tenantOrder(organizationId: string, orderId: string) {
		const order = simulator.orders.get(orderId);
		if (!order) throw new ApiError(404, 'not_found', 'Pago simulado no encontrado');
		const [stored] = await deps.db.withTenant(organizationId, (tx) =>
			tx.select({ reference: s.orders.reference }).from(s.orders).where(eq(s.orders.reference, order.request.orderReference))
		);
		if (!stored) throw new ApiError(404, 'not_found', 'Pago simulado no encontrado');
		return order;
	}

	app.get('/dev/simulator/orders/:id', async (request) => {
		const tenant = await requireTenant(request);
		const order = await tenantOrder(tenant.id, (request.params as { id: string }).id);
		return {
			id: order.id,
			reference: order.request.orderReference,
			items: order.request.items,
			totalMinor: order.facts.amountMinor,
			returnUrl: order.request.returnUrls.success
		};
	});

	app.post('/dev/simulator/pay', async (request) => {
		const tenant = await requireTenant(request);
		const body = parse(paySchema, request.body);
		const order = await tenantOrder(tenant.id, body.orderId);
		simulator.pay(order.id, body.outcome);
		const action = body.outcome === 'approved' ? 'order.processed' : body.outcome === 'rejected' ? 'order.failed' : 'order.processing';
		const webhookStatus = await notify(tenant.id, order.request.orderReference, order.id, action);
		return { orderId: order.id, webhookStatus, returnUrl: order.request.returnUrls.success };
	});

	app.post('/dev/simulator/payment-status', async (request) => {
		const tenant = await requireTenant(request);
		const body = parse(statusSchema, request.body);
		const [stored] = await deps.db.withTenant(tenant.id, (tx) =>
			tx.select({ checkoutId: s.orders.providerCheckoutId }).from(s.orders).where(eq(s.orders.reference, body.reference))
		);
		if (!stored?.checkoutId || !simulator.orders.has(stored.checkoutId)) throw new ApiError(404, 'not_found', 'Pago no encontrado');
		simulator.setStatus(stored.checkoutId, body.status);
		return { webhookStatus: await notify(tenant.id, body.reference, stored.checkoutId, `order.${body.status}`) };
	});
}
