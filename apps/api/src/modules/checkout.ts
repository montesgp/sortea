import { and, eq, publishOpsEvent, schema as s, type Tx } from '@sortea/db';
import {
	cartLineSchema,
	checkoutRequestSchema,
	countryName,
	defaultEntryDigits,
	deliveryMethods,
	normalizeDocument,
	normalizeEmail,
	organizationCountry,
	priceCart,
	quoteChances,
	receiptLookupSchema,
	shipsTo,
	type CheckoutRequest
} from '@sortea/domain';
import { generateOrderReference, generateReceiptCode, hashWithPepper, safeEqualHex } from '@sortea/domain/server';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../lib/audit';
import { couponsRemaining, ORDER_TTL_MINUTES, participationCampaign } from '../lib/campaign-state';
import { ApiError, parse } from '../lib/errors';
import { requireTenant, tenantOrigin, type Tenant } from '../lib/tenant';
import { requireMercadoPago } from '../payments/integrations';
import { ProviderError } from '../payments/provider';
import { loadCatalogEntries } from './catalog';

const quoteSchema = z.object({
	lines: z.array(cartLineSchema).min(1).max(20),
	deliveryMethod: z.enum(deliveryMethods).default('digital'),
	campaignSlug: z.string().max(80).optional()
});

export async function checkoutRoutes(app: FastifyInstance) {
	const { deps } = app;

	app.post('/checkout/quote', async (request) => {
		const tenant = await requireTenant(request);
		const body = parse(quoteSchema, request.body);
		return deps.db.withTenant(tenant.id, async (tx) => {
			const catalog = await loadCatalogEntries(tx, body.lines.map((line) => line.variantId));
			const priced = priceCart(body.lines, catalog, { now: deps.now(), deliveryFeeMinor: deliveryFee(tenant, body.deliveryMethod) });
			if (!priced.ok) return { ok: false, errors: priced.errors };
			// Chances come only from a locked rule of a campaign accepting participations, as the order will (FR-CAMP-05).
			const participation = await participationCampaign(tx, deps.now(), deps.config.COMPLIANCE_DEMO, body.campaignSlug);
			// Coupons left, so the cart can warn before paying (ADR 0014 §1).
			const remaining = participation ? await couponsRemaining(tx, participation.campaign, deps.now()) : 0;
			return {
				ok: true,
				currency: priced.currency,
				lines: priced.lines.map((line) => ({
					variantId: line.variantId,
					name: line.name,
					kind: line.kind,
					quantity: line.quantity,
					unitPriceMinor: line.unitPrice.amountMinor,
					lineTotalMinor: line.lineTotal.amountMinor
				})),
				subtotalMinor: priced.subtotal.amountMinor,
				deliveryFeeMinor: priced.deliveryFee.amountMinor,
				totalMinor: priced.total.amountMinor,
				requiresDelivery: priced.requiresDelivery,
				delivery: tenant.settings.delivery,
				chances: participation
					? {
							campaign: { slug: participation.campaign.slug, title: participation.campaign.title },
							...quoteChances(participation.rule.entryRule, priced.lines),
							remaining
						}
					: null
			};
		});
	});

	app.post('/checkout/orders', { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (request, reply) => {
		const tenant = await requireTenant(request);
		const body = parse(checkoutRequestSchema, request.body);
		const document = normalizeDocument(body.buyer.documentType, body.buyer.documentNumber);
		if (!document.ok) throw new ApiError(400, 'invalid_document', 'Revisá el número de documento');

		const accessCode = generateReceiptCode(10);
		const now = deps.now();
		const created = await deps.db.withTenant(tenant.id, async (tx) => {
			// Waits for a platform admin changing or disconnecting the account, so this
			// order is either seen by their payments-in-progress check or uses the new account.
			await tx.select({ id: s.organizations.id }).from(s.organizations).where(eq(s.organizations.id, tenant.id)).for('share');
			const integration = await requireMercadoPago(tx, tenant.id, deps.keyRing);
			// Every payment is checked against the account's merchant; without it the check would be off (S4).
			if (!integration.collectorId && !integration.simulator) {
				throw new ApiError(503, 'payments_unavailable', 'Los pagos todavía no están habilitados para este sitio');
			}
			const accessCodeHash = hashWithPepper(deps.config.LOOKUP_PEPPER, accessCode);
			const order = await createPendingOrder(tx, tenant, body, document, accessCodeHash, now, deps.config.COMPLIANCE_DEMO);
			return { order, integration };
		});

		const origin = tenantOrigin(tenant, deps.config.WEB_FALLBACK_ORIGIN);
		const resultUrl = `${origin}/checkout/resultado?ref=${encodeURIComponent(created.order.reference)}`;
		try {
			const preference = await deps.payments.createPreference(created.integration.credentials, {
				orderReference: created.order.reference,
				idempotencyKey: created.order.id,
				items: created.order.preferenceItems,
				payer: {
					email: normalizeEmail(body.buyer.email),
					firstName: body.buyer.firstName,
					lastName: body.buyer.lastName,
					documentType: document.type,
					documentNumber: document.number
				},
				notificationUrl: `${deps.config.API_PUBLIC_URL}/webhooks/mercadopago/${tenant.id}`,
				backUrls: { success: resultUrl, failure: resultUrl, pending: resultUrl },
				expiresAt: created.order.expiresAt,
				statementDescriptor: tenant.name
			});
			await deps.db.withTenant(tenant.id, (tx) =>
				tx.update(s.orders).set({ providerPreferenceId: preference.id }).where(eq(s.orders.id, created.order.id))
			);
			return reply.status(201).send({
				reference: created.order.reference,
				accessCode,
				totalMinor: created.order.totalMinor,
				redirectUrl: preference.redirectUrl
			});
		} catch (error) {
			// No payment can start without a preference, so the order stops holding coupons (ADR 0014 §1).
			await deps.db.withTenant(tenant.id, (tx) => tx.update(s.orders).set({ reservedEntries: 0 }).where(eq(s.orders.id, created.order.id)));
			if (error instanceof ProviderError) {
				request.log.warn({ status: error.status, reference: created.order.reference }, 'preference creation failed');
				throw new ApiError(502, 'payment_provider_error', 'No pudimos iniciar el pago. Probá de nuevo en unos minutos');
			}
			throw error;
		}
	});

	/** Receipt-code status check used by the return page. It never changes state (AC-03). */
	app.post('/checkout/orders/status', { config: { rateLimit: { max: 30, timeWindow: '5 minutes' } } }, async (request) => {
		const tenant = await requireTenant(request);
		const body = parse(receiptLookupSchema, request.body);
		return deps.db.withTenant(tenant.id, async (tx) => {
			const [order] = await tx.select().from(s.orders).where(eq(s.orders.reference, body.reference));
			const valid = order && safeEqualHex(order.accessCodeHash, hashWithPepper(deps.config.LOOKUP_PEPPER, body.accessCode));
			if (!order || !valid) throw new ApiError(404, 'order_not_found', 'No encontramos una compra con esos datos');
			const items = await tx.select().from(s.orderItems).where(eq(s.orderItems.orderId, order.id));
			const entries = await tx
				.select({ entryNumber: s.participationEntries.entryNumber, status: s.participationEntries.status })
				.from(s.participationEntries)
				.where(eq(s.participationEntries.orderId, order.id));
			const [campaign] = order.campaignId
				? await tx.select({ entryDigits: s.campaigns.entryDigits }).from(s.campaigns).where(eq(s.campaigns.id, order.campaignId))
				: [];
			return {
				reference: order.reference,
				status: order.status,
				totalMinor: order.totalMinor,
				currency: order.currency,
				createdAt: order.createdAt,
				paidAt: order.paidAt,
				email: maskedOrderEmail(order.buyer.email),
				items: items.map((item) => ({ name: item.name, quantity: item.quantity, kind: item.kind, lineTotalMinor: item.lineTotalMinor })),
				entries: entries.map((entry) => entry.entryNumber).sort((a, b) => a - b),
				entryDigits: campaign?.entryDigits ?? defaultEntryDigits
			};
		});
	});
}

function deliveryFee(tenant: Tenant, method: (typeof deliveryMethods)[number]): number {
	return method === 'shipping' ? tenant.settings.delivery.shippingFeeMinor : 0;
}

function maskedOrderEmail(email: string): string {
	const [local = '', domain = ''] = email.split('@');
	return `${local.slice(0, 2)}***@${domain}`;
}

async function createPendingOrder(
	tx: Tx,
	tenant: Tenant,
	body: CheckoutRequest,
	document: { type: 'DNI' | 'CUIT' | 'PASSPORT'; number: string },
	accessCodeHash: string,
	now: Date,
	complianceDemo: boolean
) {
	const catalog = await loadCatalogEntries(tx, body.lines.map((line) => line.variantId));
	const priced = priceCart(body.lines, catalog, { now, deliveryFeeMinor: deliveryFee(tenant, body.delivery.method) });
	if (!priced.ok) throw new ApiError(409, 'cart_invalid', 'Algunos productos cambiaron. Revisá tu carrito', priced.errors);

	const { delivery } = tenant.settings;
	if (priced.requiresDelivery && body.delivery.method === 'digital') {
		throw new ApiError(400, 'delivery_required', 'Elegí cómo recibir los productos físicos');
	}
	if (!priced.requiresDelivery && body.delivery.method !== 'digital') {
		throw new ApiError(400, 'delivery_not_needed', 'Tu pedido es solo digital');
	}
	if ((body.delivery.method === 'shipping' && !delivery.shippingEnabled) || (body.delivery.method === 'pickup' && !delivery.pickupEnabled)) {
		throw new ApiError(400, 'delivery_unavailable', 'Ese método de entrega no está disponible');
	}
	const country = await buyerCountryOf(tx, body);
	if (body.delivery.method === 'shipping' && !shipsTo(country)) {
		throw new ApiError(
			400,
			'shipping_unavailable_country',
			`El envío a domicilio es solo dentro de ${countryName(organizationCountry)}. Podés retirar tu pedido o comprar productos digitales`
		);
	}

	const campaign = await campaignForOrder(tx, body.campaignSlug, priced.lines, now, complianceDemo);
	const givesChances = Boolean(campaign && campaign.reservedEntries > 0);
	// Only adults may receive chances (S11); refused before anything is written.
	if (givesChances && !body.consents.adultDeclaration) {
		throw new ApiError(400, 'adult_declaration_required', 'Para recibir chances tenés que declarar que sos mayor de 18 años');
	}
	const contactId = await upsertContact(tx, tenant.id, body, document, now);
	const reference = generateOrderReference(tenant.orderPrefix);
	const expiresAt = new Date(now.getTime() + ORDER_TTL_MINUTES * 60_000);

	const [order] = await tx
		.insert(s.orders)
		.values({
			organizationId: tenant.id,
			reference,
			accessCodeHash,
			contactId,
			buyer: {
				firstName: body.buyer.firstName,
				lastName: body.buyer.lastName,
				email: normalizeEmail(body.buyer.email),
				phone: body.buyer.phone ?? null,
				country,
				province: body.buyer.province,
				city: body.buyer.city
			},
			campaignId: campaign?.id ?? null,
			ruleVersionId: campaign?.ruleVersionId ?? null,
			currency: priced.currency,
			subtotalMinor: priced.subtotal.amountMinor,
			deliveryFeeMinor: priced.deliveryFee.amountMinor,
			totalMinor: priced.total.amountMinor,
			deliveryMethod: body.delivery.method,
			deliveryAddress: body.delivery.method === 'shipping' ? (body.delivery.address ?? null) : null,
			pricingSnapshot: {
				lines: priced.lines.map((line) => ({
					variantId: line.variantId,
					name: line.name,
					quantity: line.quantity,
					unitPriceMinor: line.unitPrice.amountMinor,
					lineTotalMinor: line.lineTotal.amountMinor
				})),
				subtotalMinor: priced.subtotal.amountMinor,
				deliveryFeeMinor: priced.deliveryFee.amountMinor,
				totalMinor: priced.total.amountMinor,
				currency: priced.currency,
				pricedAt: now.toISOString()
			},
			paymentProvider: 'mercadopago',
			reservedEntries: campaign?.reservedEntries ?? 0,
			expiresAt
		})
		.returning();

	await tx.insert(s.orderItems).values(
		priced.lines.map((line) => ({
			organizationId: tenant.id,
			orderId: order!.id,
			productId: line.productId,
			variantId: line.variantId,
			name: line.name,
			kind: line.kind,
			quantity: line.quantity,
			unitPriceMinor: line.unitPrice.amountMinor,
			lineTotalMinor: line.lineTotal.amountMinor
		}))
	);

	// Read in this transaction, not from the tenant cache: the consent must name the version published right now.
	const [organization] = await tx.select({ settings: s.organizations.settings }).from(s.organizations).where(eq(s.organizations.id, tenant.id));
	const { legal } = organization!.settings;
	await tx.insert(s.contactConsents).values([
		{ organizationId: tenant.id, contactId, purpose: 'terms', granted: true, policyVersion: legal.termsVersion, source: 'checkout', orderId: order!.id },
		{ organizationId: tenant.id, contactId, purpose: 'privacy', granted: true, policyVersion: legal.privacyVersion, source: 'checkout', orderId: order!.id },
		{
			organizationId: tenant.id,
			contactId,
			purpose: 'marketing_email',
			granted: body.consents.marketingEmail,
			policyVersion: legal.privacyVersion,
			source: 'checkout',
			orderId: order!.id
		},
		// Publishing the winner's identity is decided per purchase, and only where the purchase gives coupons that can win (S5).
		// The adult declaration is part of the terms of the purchase that gives chances (S11).
		...(givesChances
			? [
					{
						organizationId: tenant.id,
						contactId,
						purpose: 'winner_publicity' as const,
						granted: body.consents.winnerPublicity,
						policyVersion: legal.privacyVersion,
						source: 'checkout',
						orderId: order!.id
					},
					{
						organizationId: tenant.id,
						contactId,
						purpose: 'adult_declaration' as const,
						granted: true,
						policyVersion: legal.termsVersion,
						source: 'checkout',
						orderId: order!.id
					}
				]
			: [])
	]);
	await audit(tx, { organizationId: tenant.id, actorType: 'buyer', action: 'order.created', targetType: 'order', targetId: order!.id, metadata: { totalMinor: order!.totalMinor } });
	await publishOpsEvent(tx, tenant.id, 'order.updated', order!.id);

	const preferenceItems = priced.lines.map((line) => ({
		id: line.variantId,
		title: line.name,
		quantity: line.quantity,
		unitPriceMinor: line.unitPrice.amountMinor,
		currency: priced.currency
	}));
	if (priced.deliveryFee.amountMinor > 0) {
		preferenceItems.push({ id: 'delivery', title: 'Envío', quantity: 1, unitPriceMinor: priced.deliveryFee.amountMinor, currency: priced.currency });
	}
	return { id: order!.id, reference, totalMinor: order!.totalMinor, expiresAt, preferenceItems };
}

/**
 * The buyer's country: the organization's when not given (ADR 0012). Any other must be in
 * the GeoNames reference data; the organization's own is accepted before it is imported.
 */
async function buyerCountryOf(tx: Tx, body: CheckoutRequest): Promise<string> {
	const country = body.buyer.country ?? organizationCountry;
	if (country === organizationCountry) return country;
	const [known] = await tx.select({ code: s.geoCountries.code }).from(s.geoCountries).where(eq(s.geoCountries.code, country));
	if (!known) throw new ApiError(400, 'unknown_country', 'Elegí un país de la lista');
	return country;
}

/**
 * Finds the buyer by normalized document. An existing contact keeps its
 * original email: lookup codes must not follow whatever email a later buyer
 * typed next to that document (see BuyerSnapshot).
 */
async function upsertContact(
	tx: Tx,
	organizationId: string,
	body: CheckoutRequest,
	document: { type: 'DNI' | 'CUIT' | 'PASSPORT'; number: string },
	now: Date
): Promise<string> {
	const [identifier] = await tx
		.select({ contactId: s.contactIdentifiers.contactId })
		.from(s.contactIdentifiers)
		.where(and(eq(s.contactIdentifiers.documentType, document.type), eq(s.contactIdentifiers.documentNumber, document.number)));
	if (identifier) return identifier.contactId;

	const [contact] = await tx
		.insert(s.contacts)
		.values({
			organizationId,
			firstName: body.buyer.firstName,
			lastName: body.buyer.lastName,
			email: normalizeEmail(body.buyer.email),
			phone: body.buyer.phone ?? null,
			createdAt: now
		})
		.returning({ id: s.contacts.id });
	const inserted = await tx
		.insert(s.contactIdentifiers)
		.values({ organizationId, contactId: contact!.id, documentType: document.type, documentNumber: document.number })
		.onConflictDoNothing()
		.returning({ contactId: s.contactIdentifiers.contactId });
	if (inserted.length > 0) return contact!.id;
	// A concurrent checkout registered the same document first.
	const [winner] = await tx
		.select({ contactId: s.contactIdentifiers.contactId })
		.from(s.contactIdentifiers)
		.where(and(eq(s.contactIdentifiers.documentType, document.type), eq(s.contactIdentifiers.documentNumber, document.number)));
	return winner!.contactId;
}

/**
 * Links the order to the campaign the cart quoted (FR-CAMP-05): the named one while it accepts
 * participations, else the open campaign closing first, with its locked rule pinned. When none
 * accepts participations, a named campaign is still linked, without a rule, so it earns nothing.
 *
 * The order reserves the chances the cart quoted. Under the campaign row lock, which payments
 * also take to allocate numbers, a cart asking for more chances than remain is refused (ADR 0014 §1).
 */
async function campaignForOrder(tx: Tx, slug: string | undefined, lines: readonly { variantId: string; quantity: number }[], now: Date, complianceDemo: boolean) {
	const current = await participationCampaign(tx, now, complianceDemo, slug);
	if (current) {
		const requested = quoteChances(current.rule.entryRule, lines).total;
		if (requested > 0) {
			const [locked] = await tx.select().from(s.campaigns).where(eq(s.campaigns.id, current.campaign.id)).for('update');
			const remaining = await couponsRemaining(tx, locked!, now);
			if (requested > remaining) {
				const { title } = current.campaign;
				throw new ApiError(
					409,
					'pool_exhausted',
					remaining === 0
						? `Se agotaron los cupones de ${title}. Quitá los productos que dan chances para continuar`
						: `${remaining === 1 ? 'Queda 1 cupón' : `Quedan ${remaining} cupones`} para ${title} y tu carrito suma ${requested === 1 ? '1 chance' : `${requested} chances`}. Quitá algunos productos para continuar`,
					{ remaining, requested }
				);
			}
		}
		return { id: current.campaign.id, ruleVersionId: current.rule.id, reservedEntries: requested };
	}
	if (!slug) return null;
	const [campaign] = await tx.select({ id: s.campaigns.id }).from(s.campaigns).where(eq(s.campaigns.slug, slug));
	return campaign ? { id: campaign.id, ruleVersionId: null, reservedEntries: 0 } : null;
}
