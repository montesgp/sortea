import { and, asc, count, desc, eq, inArray, isNotNull, or, schema as s, sql, type Tx } from '@sortea/db';
import {
	campaignPerformance,
	campaignTakesTouches,
	selectAttribution,
	trackingChannelSchema,
	trackingCodeSchema,
	trackingLinkInputSchema,
	trackingPerformance,
	type Attribution,
	type PerformanceOrder
} from '@sortea/domain';
import { generateTrackingCode } from '@sortea/domain/server';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { actorType, requireAdmin } from '../lib/admin-context';
import { audit } from '../lib/audit';
import { ApiError, notFound, parse } from '../lib/errors';
import { requireTenant, tenantOrigin } from '../lib/tenant';

/**
 * Tracking links per video (odd/tasks/tracking-links.md S1-S4). The back office creates and
 * archives them under the permission that manages campaigns; the web resolves a landing code
 * to remember the touch until the campaign closes; checkout stores the touches with the order.
 * Their performance is read under the permission that sees sales totals, without personal data.
 */
const campaignParams = z.object({ id: z.uuid() });
const linkParams = z.object({ id: z.uuid(), linkId: z.uuid() });

type LinkRow = typeof s.trackingLinks.$inferSelect;

function linkView(link: LinkRow, origin: string) {
	return {
		id: link.id,
		name: link.name,
		channel: link.channel,
		note: link.note,
		code: link.code,
		url: `${origin}/?src=${link.code}`,
		createdAt: link.createdAt,
		archivedAt: link.archivedAt
	};
}

async function loadCampaign(tx: Tx, id: string) {
	const [campaign] = await tx.select().from(s.campaigns).where(eq(s.campaigns.id, id));
	if (!campaign) throw notFound('Campaña');
	return campaign;
}

/** Paid orders of one campaign, or of every campaign: refunded and charged-back orders are no longer `paid` (S4). */
const paidOf = (campaignId: string | undefined) => and(eq(s.orders.status, 'paid'), campaignId ? eq(s.orders.campaignId, campaignId) : isNotNull(s.orders.campaignId));

/**
 * The paid purchases the performance report counts (S4), with the contact only as an internal
 * key for distinct buyers. Chances are the order's eligible entries. Net is what Mercado Pago
 * reported for the order's approved payments, minus partial refunds; null while any of them has
 * no reported net, so an unknown fee is never guessed.
 */
async function paidPurchases(tx: Tx, campaignId?: string): Promise<(PerformanceOrder & { campaignId: string })[]> {
	const { orders: o, participationEntries: entries, payments: p, orderAttributions: oa } = s;
	const chances = tx
		.select({ orderId: entries.orderId, value: sql<number>`count(*)::int`.as('chances') })
		.from(entries)
		.where(eq(entries.status, 'eligible'))
		.groupBy(entries.orderId)
		.as('order_chances');
	const net = tx
		.select({ orderId: p.orderId, value: sql<string | null>`case when count(${p.netMinor}) = count(*) then sum(${p.netMinor} - ${p.refundedMinor}) end`.as('net') })
		.from(p)
		.where(eq(p.status, 'approved'))
		.groupBy(p.orderId)
		.as('order_net');
	const [rows, attributions] = await Promise.all([
		tx
			.select({
				id: o.id,
				campaignId: o.campaignId,
				contactId: o.contactId,
				grossMinor: o.totalMinor,
				sourceChannel: o.sourceChannel,
				chances: chances.value,
				net: net.value
			})
			.from(o)
			.leftJoin(chances, eq(chances.orderId, o.id))
			.leftJoin(net, eq(net.orderId, o.id))
			.where(paidOf(campaignId)),
		tx
			.select({ orderId: oa.orderId, linkId: oa.trackingLinkId, isLast: oa.isLast })
			.from(oa)
			.innerJoin(o, eq(o.id, oa.orderId))
			.where(paidOf(campaignId))
			.orderBy(asc(oa.touchedAt))
	]);
	const linksOf = new Map<string, { linkId: string; isLast: boolean }[]>();
	for (const row of attributions) linksOf.set(row.orderId, [...(linksOf.get(row.orderId) ?? []), { linkId: row.linkId, isLast: row.isLast }]);
	return rows.map((row) => ({
		campaignId: row.campaignId!,
		contactId: row.contactId,
		chances: row.chances ?? 0,
		grossMinor: row.grossMinor,
		netMinor: row.net === null ? null : Number(row.net),
		sourceChannel: trackingChannelSchema.safeParse(row.sourceChannel).data ?? null,
		links: linksOf.get(row.id) ?? []
	}));
}

export async function trackingLinkRoutes(app: FastifyInstance) {
	const { deps } = app;

	app.get('/admin/campaigns/:id/tracking-links', async (request) => {
		const admin = await requireAdmin(request, 'campaigns.manage');
		const { id } = parse(campaignParams, request.params);
		const origin = tenantOrigin(admin.tenant, deps.config.WEB_FALLBACK_ORIGIN);
		return deps.db.withTenant(admin.tenant.id, async (tx) => {
			const campaign = await loadCampaign(tx, id);
			const links = await tx.select().from(s.trackingLinks).where(eq(s.trackingLinks.campaignId, id)).orderBy(desc(s.trackingLinks.createdAt), desc(s.trackingLinks.code));
			return {
				campaign: { id: campaign.id, title: campaign.title, status: campaign.status, closesAt: campaign.closesAt, timezone: campaign.timezone, takesTouches: campaignTakesTouches(campaign, deps.now()) },
				links: links.map((link) => linkView(link, origin))
			};
		});
	});

	app.post('/admin/campaigns/:id/tracking-links', async (request, reply) => {
		const admin = await requireAdmin(request, 'campaigns.manage');
		const { id } = parse(campaignParams, request.params);
		const body = parse(trackingLinkInputSchema, request.body);
		const origin = tenantOrigin(admin.tenant, deps.config.WEB_FALLBACK_ORIGIN);
		const link = await deps.db.withTenant(admin.tenant.id, async (tx) => {
			const campaign = await loadCampaign(tx, id);
			if (!campaign.closesAt) throw new ApiError(409, 'missing_schedule', 'Definí el cierre de la campaña antes de crear links: un link cuenta hasta el cierre');
			if (!campaignTakesTouches(campaign, deps.now())) throw new ApiError(409, 'campaign_closed', 'La campaña ya cerró: un link nuevo no sumaría compras');
			// Codes are unique per organization and never freed (links are archived, not deleted): retry on the rare collision.
			for (let attempt = 0; attempt < 5; attempt++) {
				const [created] = await tx
					.insert(s.trackingLinks)
					.values({
						organizationId: admin.tenant.id,
						campaignId: id,
						name: body.name,
						channel: body.channel,
						note: body.note ?? null,
						code: generateTrackingCode(),
						createdBy: admin.identity.userId,
						createdAt: deps.now()
					})
					.onConflictDoNothing()
					.returning();
				if (!created) continue;
				// No personal data: the code and the network identify the link.
				await audit(tx, {
					organizationId: admin.tenant.id,
					actorType: actorType(admin),
					actorId: admin.identity.userId,
					action: 'tracking_link.created',
					targetType: 'tracking_link',
					targetId: created.id,
					metadata: { campaignId: id, channel: created.channel, code: created.code }
				});
				return created;
			}
			throw new ApiError(503, 'code_unavailable', 'No pudimos generar el link. Probá de nuevo');
		});
		return reply.status(201).send({ link: linkView(link, origin) });
	});

	app.post('/admin/campaigns/:id/tracking-links/:linkId/archive', async (request) => {
		const admin = await requireAdmin(request, 'campaigns.manage');
		const { id, linkId } = parse(linkParams, request.params);
		const origin = tenantOrigin(admin.tenant, deps.config.WEB_FALLBACK_ORIGIN);
		return deps.db.withTenant(admin.tenant.id, async (tx) => {
			const [link] = await tx
				.select()
				.from(s.trackingLinks)
				.where(and(eq(s.trackingLinks.id, linkId), eq(s.trackingLinks.campaignId, id)))
				.for('update');
			if (!link) throw notFound('Link');
			if (link.archivedAt) return { link: linkView(link, origin) };
			const [archived] = await tx.update(s.trackingLinks).set({ archivedAt: deps.now() }).where(eq(s.trackingLinks.id, linkId)).returning();
			await audit(tx, {
				organizationId: admin.tenant.id,
				actorType: actorType(admin),
				actorId: admin.identity.userId,
				action: 'tracking_link.archived',
				targetType: 'tracking_link',
				targetId: linkId,
				metadata: { campaignId: id, code: link.code }
			});
			return { link: linkView(archived!, origin) };
		});
	});

	/**
	 * Performance of the campaign's links (S4): every link of the campaign, archived ones too,
	 * plus any link of another campaign that one of its paid purchases passed through, so that
	 * the "último" rows and "Sin link" add up to the campaign total.
	 */
	app.get('/admin/campaigns/:id/tracking-links/report', async (request) => {
		const admin = await requireAdmin(request, 'dashboard.view');
		const { id } = parse(campaignParams, request.params);
		return deps.db.withTenant(admin.tenant.id, async (tx) => {
			const campaign = await loadCampaign(tx, id);
			const purchases = await paidPurchases(tx, id);
			const named = [...new Set(purchases.flatMap((purchase) => purchase.links.map((link) => link.linkId)))];
			const rows = await tx
				.select({ link: s.trackingLinks, campaignTitle: s.campaigns.title })
				.from(s.trackingLinks)
				.innerJoin(s.campaigns, eq(s.campaigns.id, s.trackingLinks.campaignId))
				.where(named.length ? or(eq(s.trackingLinks.campaignId, id), inArray(s.trackingLinks.id, named)) : eq(s.trackingLinks.campaignId, id))
				.orderBy(desc(s.trackingLinks.createdAt), desc(s.trackingLinks.code));
			const own = (row: (typeof rows)[number]) => row.link.campaignId === id;
			const links = [...rows.filter(own), ...rows.filter((row) => !own(row))].map(({ link, campaignTitle }) => ({
				id: link.id,
				name: link.name,
				channel: link.channel,
				code: link.code,
				archivedAt: link.archivedAt,
				otherCampaign: link.campaignId === id ? null : { id: link.campaignId, title: campaignTitle }
			}));
			return {
				campaign: { id: campaign.id, title: campaign.title, status: campaign.status, timezone: campaign.timezone },
				currency: admin.tenant.currency,
				...trackingPerformance(links, purchases)
			};
		});
	});

	/** One row per campaign of the organization (S4), with the same totals as each campaign report. */
	app.get('/admin/tracking-links/campaigns-comparison', async (request) => {
		const admin = await requireAdmin(request, 'dashboard.view');
		return deps.db.withTenant(admin.tenant.id, async (tx) => {
			const [campaigns, linkCounts, purchases] = await Promise.all([
				tx
					.select({ id: s.campaigns.id, title: s.campaigns.title, status: s.campaigns.status, opensAt: s.campaigns.opensAt, closesAt: s.campaigns.closesAt, timezone: s.campaigns.timezone })
					.from(s.campaigns)
					.orderBy(desc(s.campaigns.opensAt), desc(s.campaigns.createdAt)),
				tx.select({ campaignId: s.trackingLinks.campaignId, value: count() }).from(s.trackingLinks).groupBy(s.trackingLinks.campaignId),
				paidPurchases(tx)
			]);
			return {
				currency: admin.tenant.currency,
				campaigns: campaigns.map((campaign) => ({
					...campaign,
					links: linkCounts.find((row) => row.campaignId === campaign.id)?.value ?? 0,
					...campaignPerformance(purchases.filter((purchase) => purchase.campaignId === campaign.id))
				}))
			};
		});
	});

	/**
	 * Landing code (S2): an active link of a campaign that still takes touches, with the time its
	 * touch is remembered until (the campaign's close). Anything else is unknown, the same way.
	 */
	app.get('/public/tracking-links/:code', async (request) => {
		const tenant = await requireTenant(request);
		const code = trackingCodeSchema.safeParse((request.params as { code?: unknown }).code);
		if (!code.success) throw notFound('Link');
		return deps.db.withTenant(tenant.id, async (tx) => {
			const [row] = await tx
				.select({ code: s.trackingLinks.code, archivedAt: s.trackingLinks.archivedAt, status: s.campaigns.status, closesAt: s.campaigns.closesAt })
				.from(s.trackingLinks)
				.innerJoin(s.campaigns, eq(s.campaigns.id, s.trackingLinks.campaignId))
				.where(eq(s.trackingLinks.code, code.data));
			if (!row || row.archivedAt || !campaignTakesTouches(row, deps.now())) throw notFound('Link');
			return { code: row.code, until: row.closesAt };
		});
	});
}

/**
 * Stores the attribution of a new order, inside its transaction (S3): the organization's
 * active links of campaigns still taking touches, the last one marked; or, when none is
 * valid, the network guessed from the referrer. Tampered or foreign codes are dropped.
 * It writes only attribution: the order's prices, chances and status stay as they are.
 */
export async function recordAttribution(tx: Tx, organizationId: string, orderId: string, attribution: Attribution | undefined, now: Date): Promise<void> {
	if (!attribution) return;
	const codes = [...new Set(attribution.touches.map((touch) => touch.code))];
	// RLS scopes the query to the tenant: another organization's code is simply not found.
	const links = codes.length
		? await tx
				.select({ id: s.trackingLinks.id, code: s.trackingLinks.code, createdAt: s.trackingLinks.createdAt, archivedAt: s.trackingLinks.archivedAt, status: s.campaigns.status, closesAt: s.campaigns.closesAt })
				.from(s.trackingLinks)
				.innerJoin(s.campaigns, eq(s.campaigns.id, s.trackingLinks.campaignId))
				.where(inArray(s.trackingLinks.code, codes))
		: [];
	const rows = selectAttribution(
		attribution.touches,
		links.map((link) => ({ id: link.id, code: link.code, createdAt: link.createdAt, archivedAt: link.archivedAt, campaign: { status: link.status, closesAt: link.closesAt } })),
		now
	);
	if (rows.length) {
		await tx.insert(s.orderAttributions).values(rows.map((row) => ({ organizationId, orderId, trackingLinkId: row.trackingLinkId, touchedAt: row.touchedAt, isLast: row.isLast })));
	} else if (attribution.channel) {
		await tx.update(s.orders).set({ sourceChannel: attribution.channel }).where(eq(s.orders.id, orderId));
	}
}
