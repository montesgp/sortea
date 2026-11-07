import { and, desc, eq, inArray, schema as s, type Tx } from '@sortea/db';
import { campaignTakesTouches, selectAttribution, trackingCodeSchema, trackingLinkInputSchema, type Attribution } from '@sortea/domain';
import { generateTrackingCode } from '@sortea/domain/server';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { actorType, requireAdmin } from '../lib/admin-context';
import { audit } from '../lib/audit';
import { ApiError, notFound, parse } from '../lib/errors';
import { requireTenant, tenantOrigin } from '../lib/tenant';

/**
 * Tracking links per video (odd/tasks/tracking-links.md S1-S3). The back office creates and
 * archives them under the permission that manages campaigns; the web resolves a landing code
 * to remember the touch until the campaign closes; checkout stores the touches with the order.
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
