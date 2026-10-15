import { and, asc, count, desc, eq, ne, publishOpsEvent, schema as s, sql, type Tx } from '@sortea/db';
import {
	canChangeProductKind,
	canRemovePrize,
	canSetProductStatus,
	prizeInputSchema,
	prizesEditable,
	productInputSchema,
	variantInputSchema
} from '@sortea/domain';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { actorType, requireAdmin, type AdminContext } from '../lib/admin-context';
import { audit } from '../lib/audit';
import { ApiError, notFound, parse } from '../lib/errors';

/**
 * Catalog and prize administration (FR-COM-01, FR-CAMP-03, FR-OPS-04).
 * Products are archived and variants deactivated, never deleted; prizes can
 * change only until the campaign opens.
 */

const idParams = z.object({ id: z.uuid() });
const productPatch = productInputSchema.partial();
const statusBody = z.object({ status: z.enum(['draft', 'active', 'archived']) });
const prizePatch = prizeInputSchema.partial();

function actor(admin: AdminContext) {
	return { organizationId: admin.tenant.id, actorType: actorType(admin), actorId: admin.identity.userId };
}

async function loadProduct(tx: Tx, id: string, lock = false) {
	const query = tx.select().from(s.products).where(eq(s.products.id, id));
	const [product] = lock ? await query.for('update') : await query;
	if (!product) throw notFound('Producto');
	return product;
}

async function productOrdered(tx: Tx, productId: string): Promise<boolean> {
	const [row] = await tx.select({ value: count() }).from(s.orderItems).where(eq(s.orderItems.productId, productId));
	return (row?.value ?? 0) > 0;
}

async function assertSlugFree(tx: Tx, slug: string, exceptId?: string) {
	const [taken] = await tx
		.select({ id: s.products.id })
		.from(s.products)
		.where(and(eq(s.products.slug, slug), exceptId ? ne(s.products.id, exceptId) : undefined));
	if (taken) throw new ApiError(409, 'slug_taken', 'Ya hay un producto con esa dirección');
}

async function assertSkuFree(tx: Tx, sku: string, exceptId?: string) {
	const [taken] = await tx
		.select({ id: s.productVariants.id })
		.from(s.productVariants)
		.where(and(eq(s.productVariants.sku, sku), exceptId ? ne(s.productVariants.id, exceptId) : undefined));
	if (taken) throw new ApiError(409, 'sku_taken', 'Ya hay una variante con ese código (SKU)');
}

async function productDetail(tx: Tx, id: string) {
	const product = await loadProduct(tx, id);
	const [variants, assets, sold, rules] = await Promise.all([
		tx.select().from(s.productVariants).where(eq(s.productVariants.productId, id)).orderBy(asc(s.productVariants.createdAt)),
		tx.select().from(s.productAssets).where(eq(s.productAssets.productId, id)),
		tx
			.select({ variantId: s.orderItems.variantId, units: sql<number>`coalesce(sum(${s.orderItems.quantity}), 0)::int` })
			.from(s.orderItems)
			.innerJoin(s.orders, eq(s.orders.id, s.orderItems.orderId))
			.where(and(eq(s.orderItems.productId, id), eq(s.orders.status, 'paid')))
			.groupBy(s.orderItems.variantId),
		tx
			.select({ rule: s.campaignRuleVersions, campaign: s.campaigns })
			.from(s.campaignRuleVersions)
			.innerJoin(s.campaigns, eq(s.campaigns.id, s.campaignRuleVersions.campaignId))
			.where(ne(s.campaigns.status, 'archived'))
			.orderBy(desc(s.campaigns.closesAt), desc(s.campaignRuleVersions.version))
	]);
	// Chances live in each campaign's current rules (S5): the latest version, editable or locked.
	const variantIds = new Set(variants.map((variant) => variant.id));
	const currentRules = rules.filter((row, index) => rules.findIndex((other) => other.campaign.id === row.campaign.id) === index);
	const chances = currentRules
		.map(({ rule, campaign }) => ({
			campaignId: campaign.id,
			campaignTitle: campaign.title,
			campaignStatus: campaign.status,
			locked: rule.status !== 'draft',
			perUnit: Object.fromEntries(Object.entries(rule.entryRule.entriesPerUnit).filter(([variantId, perUnit]) => variantIds.has(variantId) && perUnit > 0))
		}))
		.filter((entry) => Object.keys(entry.perUnit).length > 0);
	return {
		id: product.id,
		slug: product.slug,
		name: product.name,
		description: product.description,
		kind: product.kind,
		status: product.status,
		imageUrl: product.imageUrl,
		position: product.position,
		kindLocked: !canChangeProductKind(await productOrdered(tx, id)),
		variants: variants.map((variant) => ({
			id: variant.id,
			sku: variant.sku,
			name: variant.name,
			priceMinor: variant.priceMinor,
			currency: variant.currency,
			stock: variant.stock,
			maxPerOrder: variant.maxPerOrder,
			availableFrom: variant.availableFrom,
			availableUntil: variant.availableUntil,
			active: variant.active,
			soldUnits: sold.find((row) => row.variantId === variant.id)?.units ?? 0
		})),
		assets: assets.map((asset) => ({ id: asset.id, filename: asset.filename, contentType: asset.contentType, sizeBytes: asset.sizeBytes })),
		chances
	};
}

async function loadCampaignForPrizes(tx: Tx, campaignId: string) {
	const [campaign] = await tx.select().from(s.campaigns).where(eq(s.campaigns.id, campaignId)).for('update');
	if (!campaign) throw notFound('Campaña');
	if (!prizesEditable(campaign.status)) {
		throw new ApiError(409, 'prizes_locked', 'Los premios quedan fijos cuando la campaña abre: forman parte de lo publicado en las bases');
	}
	return campaign;
}

function prizeView(prize: typeof s.prizes.$inferSelect) {
	return {
		id: prize.id,
		position: prize.position,
		kind: prize.kind,
		title: prize.title,
		description: prize.description,
		declaredValueMinor: prize.declaredValueMinor,
		currency: prize.currency,
		quantity: prize.quantity,
		alternatesCount: prize.alternatesCount,
		conditions: prize.conditions,
		imageUrl: prize.imageUrl
	};
}

async function campaignPrizes(tx: Tx, campaignId: string) {
	const prizes = await tx.select().from(s.prizes).where(eq(s.prizes.campaignId, campaignId)).orderBy(asc(s.prizes.position), asc(s.prizes.createdAt));
	return { prizes: prizes.map(prizeView) };
}

export async function catalogAdminRoutes(app: FastifyInstance) {
	const { deps } = app;

	// ─── Products ────────────────────────────────────────────────────────────

	app.get('/admin/products', async (request) => {
		const admin = await requireAdmin(request, 'campaigns.view');
		return deps.db.withTenant(admin.tenant.id, async (tx) => {
			const [products, variants] = await Promise.all([
				tx.select().from(s.products).orderBy(asc(s.products.position), asc(s.products.name)),
				tx.select().from(s.productVariants)
			]);
			return {
				canManage: admin.permissions.includes('catalog.manage'),
				products: products.map((product) => {
					const own = variants.filter((variant) => variant.productId === product.id);
					const prices = own.filter((variant) => variant.active).map((variant) => variant.priceMinor);
					return {
						id: product.id,
						slug: product.slug,
						name: product.name,
						kind: product.kind,
						status: product.status,
						position: product.position,
						variants: own.length,
						activeVariants: own.filter((variant) => variant.active).length,
						fromPriceMinor: prices.length ? Math.min(...prices) : null,
						stock: own.some((variant) => variant.stock === null) ? null : own.reduce((sum, variant) => sum + (variant.stock ?? 0), 0)
					};
				})
			};
		});
	});

	app.get('/admin/products/:id', async (request) => {
		const admin = await requireAdmin(request, 'campaigns.view');
		const { id } = parse(idParams, request.params);
		return deps.db.withTenant(admin.tenant.id, (tx) => productDetail(tx, id));
	});

	/** New products start as drafts: nothing is on sale until a variant exists and someone activates it. */
	app.post('/admin/products', async (request, reply) => {
		const admin = await requireAdmin(request, 'catalog.manage');
		const body = parse(productInputSchema, request.body);
		const detail = await deps.db.withTenant(admin.tenant.id, async (tx) => {
			await assertSlugFree(tx, body.slug);
			const [last] = await tx.select({ value: sql<number>`coalesce(max(${s.products.position}), -1)::int` }).from(s.products);
			const [product] = await tx
				.insert(s.products)
				.values({
					organizationId: admin.tenant.id,
					slug: body.slug,
					name: body.name,
					description: body.description,
					kind: body.kind,
					imageUrl: body.imageUrl ?? null,
					position: body.position ?? (last?.value ?? -1) + 1,
					status: 'draft'
				})
				.returning({ id: s.products.id });
			await audit(tx, { ...actor(admin), action: 'product.created', targetType: 'product', targetId: product!.id, metadata: { slug: body.slug, kind: body.kind } });
			return productDetail(tx, product!.id);
		});
		return reply.status(201).send(detail);
	});

	app.patch('/admin/products/:id', async (request) => {
		const admin = await requireAdmin(request, 'catalog.manage');
		const { id } = parse(idParams, request.params);
		const body = parse(productPatch, request.body);
		return deps.db.withTenant(admin.tenant.id, async (tx) => {
			const product = await loadProduct(tx, id, true);
			if (body.slug && body.slug !== product.slug) await assertSlugFree(tx, body.slug, id);
			if (body.kind && body.kind !== product.kind && !canChangeProductKind(await productOrdered(tx, id))) {
				throw new ApiError(409, 'kind_locked', 'El tipo no cambia cuando el producto ya tiene pedidos: define cómo se entregó');
			}
			await tx
				.update(s.products)
				.set({ ...body, updatedAt: deps.now() })
				.where(eq(s.products.id, id));
			await audit(tx, { ...actor(admin), action: 'product.updated', targetType: 'product', targetId: id, metadata: { fields: Object.keys(body) } });
			return productDetail(tx, id);
		});
	});

	app.post('/admin/products/:id/status', async (request) => {
		const admin = await requireAdmin(request, 'catalog.manage');
		const { id } = parse(idParams, request.params);
		const { status } = parse(statusBody, request.body);
		return deps.db.withTenant(admin.tenant.id, async (tx) => {
			const product = await loadProduct(tx, id, true);
			const [active] = await tx
				.select({ value: count() })
				.from(s.productVariants)
				.where(and(eq(s.productVariants.productId, id), eq(s.productVariants.active, true)));
			const check = canSetProductStatus(product.status, status, active?.value ?? 0);
			if (!check.ok) {
				throw new ApiError(
					409,
					check.reason,
					check.reason === 'needs_active_variant' ? 'Agregá al menos una variante activa antes de publicar el producto' : 'Un producto archivado vuelve primero a borrador'
				);
			}
			await tx.update(s.products).set({ status, updatedAt: deps.now() }).where(eq(s.products.id, id));
			await audit(tx, { ...actor(admin), action: 'product.status', targetType: 'product', targetId: id, metadata: { from: product.status, to: status } });
			return productDetail(tx, id);
		});
	});

	app.post('/admin/products/:id/variants', async (request, reply) => {
		const admin = await requireAdmin(request, 'catalog.manage');
		const { id } = parse(idParams, request.params);
		const body = parse(variantInputSchema, request.body);
		const detail = await deps.db.withTenant(admin.tenant.id, async (tx) => {
			await loadProduct(tx, id, true);
			await assertSkuFree(tx, body.sku);
			const [variant] = await tx
				.insert(s.productVariants)
				.values({
					organizationId: admin.tenant.id,
					productId: id,
					sku: body.sku,
					name: body.name,
					priceMinor: body.priceMinor,
					// Prices are always in the organization's currency (a cart cannot mix currencies).
					currency: admin.tenant.currency,
					stock: body.stock,
					maxPerOrder: body.maxPerOrder,
					availableFrom: body.availableFrom ?? null,
					availableUntil: body.availableUntil ?? null,
					active: body.active ?? true
				})
				.returning({ id: s.productVariants.id });
			await audit(tx, { ...actor(admin), action: 'variant.created', targetType: 'product', targetId: id, metadata: { variantId: variant!.id, sku: body.sku, priceMinor: body.priceMinor } });
			return productDetail(tx, id);
		});
		return reply.status(201).send(detail);
	});

	app.patch('/admin/variants/:id', async (request) => {
		const admin = await requireAdmin(request, 'catalog.manage');
		const { id } = parse(idParams, request.params);
		return deps.db.withTenant(admin.tenant.id, async (tx) => {
			const [current] = await tx.select().from(s.productVariants).where(eq(s.productVariants.id, id)).for('update');
			if (!current) throw notFound('Variante');
			// Validate the merged result so the window and limits stay consistent as a whole.
			const merged = parse(variantInputSchema, {
				sku: current.sku,
				name: current.name,
				priceMinor: current.priceMinor,
				stock: current.stock,
				maxPerOrder: current.maxPerOrder,
				availableFrom: current.availableFrom,
				availableUntil: current.availableUntil,
				active: current.active,
				...(request.body as Record<string, unknown>)
			});
			if (merged.sku !== current.sku) await assertSkuFree(tx, merged.sku, id);
			const [product] = await tx.select().from(s.products).where(eq(s.products.id, current.productId));
			if (!merged.active && product?.status === 'active') {
				const [others] = await tx
					.select({ value: count() })
					.from(s.productVariants)
					.where(and(eq(s.productVariants.productId, current.productId), eq(s.productVariants.active, true), ne(s.productVariants.id, id)));
				if ((others?.value ?? 0) === 0) {
					throw new ApiError(409, 'last_active_variant', 'Es la única variante activa de un producto publicado. Pasá el producto a borrador o archivalo primero');
				}
			}
			const changes = {
				sku: merged.sku,
				name: merged.name,
				priceMinor: merged.priceMinor,
				stock: merged.stock,
				maxPerOrder: merged.maxPerOrder,
				availableFrom: merged.availableFrom ?? null,
				availableUntil: merged.availableUntil ?? null,
				active: merged.active ?? current.active
			};
			await tx.update(s.productVariants).set(changes).where(eq(s.productVariants.id, id));
			const changed = (Object.keys(changes) as (keyof typeof changes)[]).filter((key) => String(changes[key]) !== String(current[key]));
			await audit(tx, {
				...actor(admin),
				action: 'variant.updated',
				targetType: 'product',
				targetId: current.productId,
				metadata: {
					variantId: id,
					fields: changed,
					...(changed.includes('priceMinor') ? { priceFrom: current.priceMinor, priceTo: changes.priceMinor } : {}),
					...(changed.includes('stock') ? { stockFrom: current.stock, stockTo: changes.stock } : {})
				}
			});
			return productDetail(tx, current.productId);
		});
	});

	// ─── Prizes ──────────────────────────────────────────────────────────────

	app.get('/admin/campaigns/:id/prizes', async (request) => {
		const admin = await requireAdmin(request, 'campaigns.view');
		const { id } = parse(idParams, request.params);
		return deps.db.withTenant(admin.tenant.id, async (tx) => {
			const [campaign] = await tx.select().from(s.campaigns).where(eq(s.campaigns.id, id));
			if (!campaign) throw notFound('Campaña');
			return { ...(await campaignPrizes(tx, id)), editable: prizesEditable(campaign.status) && admin.permissions.includes('campaigns.manage') };
		});
	});

	app.post('/admin/campaigns/:id/prizes', async (request, reply) => {
		const admin = await requireAdmin(request, 'campaigns.manage');
		const { id } = parse(idParams, request.params);
		const body = parse(prizeInputSchema, request.body);
		const result = await deps.db.withTenant(admin.tenant.id, async (tx) => {
			await loadCampaignForPrizes(tx, id);
			const [last] = await tx.select({ value: sql<number>`coalesce(max(${s.prizes.position}), 0)::int` }).from(s.prizes).where(eq(s.prizes.campaignId, id));
			const [prize] = await tx
				.insert(s.prizes)
				.values({
					organizationId: admin.tenant.id,
					campaignId: id,
					position: body.position ?? (last?.value ?? 0) + 1,
					kind: body.kind,
					title: body.title,
					description: body.description ?? null,
					declaredValueMinor: body.declaredValueMinor,
					currency: admin.tenant.currency,
					quantity: body.quantity,
					alternatesCount: body.alternatesCount,
					conditions: body.conditions ?? null,
					imageUrl: body.imageUrl ?? null
				})
				.returning({ id: s.prizes.id });
			await audit(tx, { ...actor(admin), action: 'prize.created', targetType: 'campaign', targetId: id, metadata: { prizeId: prize!.id, kind: body.kind, quantity: body.quantity } });
			await publishOpsEvent(tx, admin.tenant.id, 'campaign.updated', id);
			return campaignPrizes(tx, id);
		});
		return reply.status(201).send(result);
	});

	app.patch('/admin/prizes/:id', async (request) => {
		const admin = await requireAdmin(request, 'campaigns.manage');
		const { id } = parse(idParams, request.params);
		const body = parse(prizePatch, request.body);
		return deps.db.withTenant(admin.tenant.id, async (tx) => {
			const [prize] = await tx.select().from(s.prizes).where(eq(s.prizes.id, id));
			if (!prize) throw notFound('Premio');
			await loadCampaignForPrizes(tx, prize.campaignId);
			await tx.update(s.prizes).set(body).where(eq(s.prizes.id, id));
			await audit(tx, { ...actor(admin), action: 'prize.updated', targetType: 'campaign', targetId: prize.campaignId, metadata: { prizeId: id, fields: Object.keys(body) } });
			await publishOpsEvent(tx, admin.tenant.id, 'campaign.updated', prize.campaignId);
			return campaignPrizes(tx, prize.campaignId);
		});
	});

	app.delete('/admin/prizes/:id', async (request) => {
		const admin = await requireAdmin(request, 'campaigns.manage');
		const { id } = parse(idParams, request.params);
		return deps.db.withTenant(admin.tenant.id, async (tx) => {
			const [prize] = await tx.select().from(s.prizes).where(eq(s.prizes.id, id));
			if (!prize) throw notFound('Premio');
			const campaign = await loadCampaignForPrizes(tx, prize.campaignId);
			const [total] = await tx.select({ value: count() }).from(s.prizes).where(eq(s.prizes.campaignId, campaign.id));
			if (!canRemovePrize(campaign.status, total?.value ?? 0)) {
				throw new ApiError(409, 'last_prize', 'Una campaña publicada necesita al menos un premio');
			}
			await tx.delete(s.prizes).where(eq(s.prizes.id, id));
			await audit(tx, {
				...actor(admin),
				action: 'prize.deleted',
				targetType: 'campaign',
				targetId: campaign.id,
				metadata: { prizeId: id, title: prize.title, quantity: prize.quantity, declaredValueMinor: prize.declaredValueMinor }
			});
			await publishOpsEvent(tx, admin.tenant.id, 'campaign.updated', campaign.id);
			return campaignPrizes(tx, campaign.id);
		});
	});
}

