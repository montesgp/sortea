import { and, asc, count, countDistinct, desc, eq, gt, inArray, or, publishOpsEvent, schema as s, sql, sum, type SQL, type Tx } from '@sortea/db';
import {
	allowedTransitions,
	approvalSatisfied,
	buildManifest,
	campaignVideoSchema,
	campaignStatuses,
	canReopen,
	canTransition,
	decideRuleChange,
	defaultEntryDigits,
	entriesPerUnitFromInput,
	maskDocument,
	maskEmail,
	orderPublicity,
	orderStatuses,
	publicContact,
	publicSocial,
	socialLinksSchema,
	serializeManifest,
	whatsappNumberSchema,
	type CampaignStatus
} from '@sortea/domain';
import { hashManifest, sha256Hex } from '@sortea/domain/server';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { actorType, requireAdmin, type AdminContext } from '../lib/admin-context';
import { audit } from '../lib/audit';
import { campaignGate, latestRuleVersion, lockedRuleVersion, ORDER_TTL_MINUTES } from '../lib/campaign-state';
import { ApiError, notFound, parse } from '../lib/errors';
import { assertOwnMedia } from '../lib/media';
import { saveSocial, saveWhatsApp } from '../lib/organization-contact';
import { campaignDateTime, publishedRounds, unresolvedAwardSlots, vacantSlots } from './awards';
import { videoChange } from './catalog-admin';
import { currentSequence } from './live';
import { publicityDecisions } from './winners';

const idParams = z.object({ id: z.uuid() });
const httpsUrl = z.url({ protocol: /^https$/ });

const ordersQuery = z.object({
	status: z.enum(orderStatuses).optional(),
	q: z.string().trim().max(40).optional(),
	page: z.coerce.number().int().min(1).max(500).default(1)
});

/** Lowercases and drops Spanish accents in SQL, without the `unaccent` extension. */
const ACCENTED = 'áàäâéèëêíìïîóòöôúùüûñç';
const PLAIN = 'aaaaeeeeiiiioooouuuunc';
const fold = (value: SQL) => sql`translate(lower(${value}), ${ACCENTED}, ${PLAIN})`;

/**
 * Orders matching the list search (S4): the reference for every admin; the buyer's
 * first name, last name, full name or email only with `orders.pii` (ADR 0010), so
 * nobody else can confirm a stranger's email by trial.
 */
function orderSearch(term: string, withBuyer: boolean) {
	const pattern = `%${term.replace(/[%_]/g, '').replace(/\s+/g, ' ')}%`;
	const byReference = sql`${s.orders.reference} ilike ${pattern}`;
	if (!withBuyer) return byReference;
	const like = fold(sql`${pattern}`);
	const first = sql`(${s.orders.buyer} ->> 'firstName')`;
	const last = sql`(${s.orders.buyer} ->> 'lastName')`;
	return or(
		byReference,
		sql`${fold(first)} like ${like}`,
		sql`${fold(last)} like ${like}`,
		sql`${fold(sql`${first} || ' ' || ${last}`)} like ${like}`,
		sql`${fold(sql`(${s.orders.buyer} ->> 'email')`)} like ${like}`
	);
}

const campaignPatch = z.object({
	title: z.string().trim().min(3).max(120).optional(),
	subtitle: z.string().trim().max(120).nullable().optional(),
	summary: z.string().trim().min(10).max(1200).optional(),
	streamUrl: httpsUrl.nullable().optional(),
	replayUrl: httpsUrl.nullable().optional(),
	opensAt: z.coerce.date().optional(),
	closesAt: z.coerce.date().optional(),
	drawAt: z.coerce.date().nullable().optional(),
	/** Presentation only, so it stays editable after the campaign opens (S9). */
	video: campaignVideoSchema.optional(),
	/** Products the campaign page shows; empty shows every active product. Presentation only too (2026-10-18b). */
	productIds: z
		.array(z.uuid())
		.max(50)
		.transform((ids) => [...new Set(ids)])
		.optional()
});

const approvalBody = z
	.object({
		status: z.enum(['pending', 'approved', 'rejected']),
		reference: z.string().trim().max(120).optional(),
		authority: z.string().trim().max(160).optional(),
		notes: z.string().trim().max(1000).optional()
	})
	.refine((value) => value.status !== 'approved' || (value.reference && value.authority), {
		message: 'Una aprobación necesita autoridad y número de referencia',
		path: ['reference']
	});

/** "Constancia en papel" (ADR 0015): the owner attests every required approval, or withdraws that statement. */
const paperAttestationBody = z.object({ attested: z.boolean() });

/** Approvals are decided before the campaign opens and stay fixed after that. */
function assertApprovalsEditable(status: CampaignStatus) {
	if (!['draft', 'review', 'published'].includes(status)) {
		throw new ApiError(409, 'approvals_locked', 'Las aprobaciones no se modifican con la campaña abierta');
	}
}

const rulesBody = z.object({
	/** Optional when a version exists: the chances table saves without retyping the text. */
	bodyMarkdown: z.string().trim().min(20).max(50_000).optional(),
	eligibility: z.object({ minAge: z.number().int().min(16).max(99), residency: z.string().max(120), excluded: z.array(z.string().max(200)).max(20) }).optional(),
	entriesPerUnit: z.record(z.uuid(), z.number().int().min(0).max(100)).optional(),
	maxEntriesPerIdentity: z.number().int().min(1).max(100_000).nullable().optional(),
	announcement: z.string().trim().max(2000).optional()
});

/** A new round after a vacancy (ADR 0014 §5): a new closing date and, optionally, a new draw or stream date. */
const reopenBody = z.object({
	closesAt: z.coerce.date('Indicá el nuevo cierre'),
	drawAt: z.coerce.date().nullable().optional()
});

const drawEventBody = z.object({
	kind: z.enum(['stream_scheduled', 'mechanism_recorded', 'act_published', 'result_published', 'note']),
	title: z.string().trim().min(3).max(160),
	detail: z.string().trim().max(4000).optional(),
	evidenceUrl: httpsUrl.optional(),
	occurredAt: z.coerce.date()
});

export async function adminRoutes(app: FastifyInstance) {
	const { deps } = app;

	app.get('/admin/session', async (request) => {
		const admin = await requireAdmin(request);
		return {
			user: { id: admin.identity.userId, email: admin.identity.email, aal: admin.identity.aal },
			role: admin.role,
			permissions: admin.permissions,
			organization: { name: admin.tenant.name, slug: admin.tenant.slug, timezone: admin.tenant.timezone, currency: admin.tenant.currency }
		};
	});

	/** Settings the organization edits itself (S5); the platform console edits the same values. */
	app.get('/admin/settings', async (request) => {
		const admin = await requireAdmin(request, 'settings.manage');
		const [org] = await deps.db.withTenant(admin.tenant.id, (tx) => tx.select({ settings: s.organizations.settings }).from(s.organizations));
		return { contact: publicContact(org!.settings.contact), social: publicSocial(org!.settings.social) };
	});

	app.put('/admin/settings/contact', async (request) => {
		const admin = await requireAdmin(request, 'settings.manage');
		const { whatsapp } = parse(z.object({ whatsapp: whatsappNumberSchema }), request.body);
		const contact = await deps.db.withTenant(admin.tenant.id, async (tx) => {
			const saved = await saveWhatsApp(tx, admin.tenant.id, whatsapp, deps.now());
			await audit(tx, { organizationId: admin.tenant.id, actorType: actorType(admin), actorId: admin.identity.userId, action: 'organization.contact_updated', targetType: 'organization', targetId: admin.tenant.id, metadata: { whatsapp: Boolean(whatsapp) } });
			return saved;
		});
		// The public site reads the contact from the cached tenant settings.
		app.tenants.invalidate();
		return { contact };
	});

	/** Social links shown on the public site (S8, 2026-10-18); an empty field removes that network. */
	app.put('/admin/settings/social', async (request) => {
		const admin = await requireAdmin(request, 'settings.manage');
		const links = parse(socialLinksSchema, request.body);
		const social = await deps.db.withTenant(admin.tenant.id, async (tx) => {
			const saved = await saveSocial(tx, admin.tenant.id, links, deps.now());
			await audit(tx, { organizationId: admin.tenant.id, actorType: actorType(admin), actorId: admin.identity.userId, action: 'organization.social_updated', targetType: 'organization', targetId: admin.tenant.id, metadata: { networks: Object.keys(saved) } });
			return saved;
		});
		app.tenants.invalidate();
		return { social };
	});

	/** Snapshot for the operations dashboard; the client re-requests it to resync (FR-OPS-01/02). */
	app.get('/admin/overview', async (request) => {
		const admin = await requireAdmin(request, 'dashboard.view');
		return deps.db.withTenant(admin.tenant.id, (tx) => overview(tx, admin, deps.now()));
	});

	app.get('/admin/orders', async (request) => {
		const admin = await requireAdmin(request, 'orders.view');
		const query = parse(ordersQuery, request.query);
		const pageSize = 25;
		return deps.db.withTenant(admin.tenant.id, async (tx) => {
			const filters = and(
				query.status ? eq(s.orders.status, query.status) : undefined,
				query.q ? orderSearch(query.q, admin.permissions.includes('orders.pii')) : undefined
			);
			const [rows, [total]] = await Promise.all([
				tx
					.select()
					.from(s.orders)
					.where(filters)
					.orderBy(desc(s.orders.createdAt))
					.limit(pageSize)
					.offset((query.page - 1) * pageSize),
				tx.select({ value: count() }).from(s.orders).where(filters)
			]);
			return {
				orders: rows.map((order) => ({
					id: order.id,
					reference: order.reference,
					status: order.status,
					totalMinor: order.totalMinor,
					currency: order.currency,
					deliveryMethod: order.deliveryMethod,
					buyer: `${order.buyer.firstName} ${order.buyer.lastName.slice(0, 1)}.`,
					email: maskEmail(order.buyer.email),
					// The province is coarse enough for lists; the city stays in the detail (S7).
					province: order.buyer.province ?? null,
					createdAt: order.createdAt,
					paidAt: order.paidAt
				})),
				page: query.page,
				pageSize,
				total: total?.value ?? 0
			};
		});
	});

	app.get('/admin/orders/:id', async (request) => {
		const admin = await requireAdmin(request, 'orders.view');
		const { id } = parse(idParams, request.params);
		const showPii = admin.permissions.includes('orders.pii');
		return deps.db.withTenant(admin.tenant.id, async (tx) => {
			const [order] = await tx.select().from(s.orders).where(eq(s.orders.id, id));
			if (!order) throw notFound('Orden');
			const [items, payments, entries, [identifier], consents, publicity] = await Promise.all([
				tx.select().from(s.orderItems).where(eq(s.orderItems.orderId, id)),
				tx.select().from(s.payments).where(eq(s.payments.orderId, id)).orderBy(asc(s.payments.createdAt)),
				tx.select().from(s.participationEntries).where(eq(s.participationEntries.orderId, id)).orderBy(asc(s.participationEntries.entryNumber)),
				tx.select().from(s.contactIdentifiers).where(eq(s.contactIdentifiers.contactId, order.contactId)),
				tx.select().from(s.contactConsents).where(eq(s.contactConsents.orderId, id)),
				publicityDecisions(tx, [order.contactId])
			]);
			const [campaign] = order.campaignId ? await tx.select({ entryDigits: s.campaigns.entryDigits }).from(s.campaigns).where(eq(s.campaigns.id, order.campaignId)) : [];
			if (showPii) {
				await audit(tx, { organizationId: admin.tenant.id, actorType: actorType(admin), actorId: admin.identity.userId, action: 'order.pii_viewed', targetType: 'order', targetId: id });
			}
			return {
				id: order.id,
				reference: order.reference,
				status: order.status,
				currency: order.currency,
				subtotalMinor: order.subtotalMinor,
				deliveryFeeMinor: order.deliveryFeeMinor,
				totalMinor: order.totalMinor,
				deliveryMethod: order.deliveryMethod,
				createdAt: order.createdAt,
				paidAt: order.paidAt,
				piiVisible: showPii,
				buyer: showPii
					? {
							...order.buyer,
							province: order.buyer.province ?? null,
							city: order.buyer.city ?? null,
							document: identifier ? `${identifier.documentType} ${identifier.documentNumber}` : null,
							address: order.deliveryAddress
						}
					: {
							firstName: order.buyer.firstName,
							lastName: `${order.buyer.lastName.slice(0, 1)}.`,
							email: maskEmail(order.buyer.email),
							phone: null,
							province: order.buyer.province ?? null,
							city: null,
							document: identifier ? `${identifier.documentType} ${maskDocument(identifier.documentNumber)}` : null,
							address: null
						},
				items: items.map((item) => ({ name: item.name, kind: item.kind, quantity: item.quantity, unitPriceMinor: item.unitPriceMinor, lineTotalMinor: item.lineTotalMinor })),
				payments: payments.map((payment) => ({
					providerPaymentId: payment.providerPaymentId,
					status: payment.status,
					statusDetail: payment.statusDetail,
					amountMinor: payment.amountMinor,
					approvedAt: payment.approvedAt,
					updatedAt: payment.updatedAt
				})),
				entries: entries.map((entry) => ({ number: entry.entryNumber, status: entry.status })),
				entryDigits: campaign?.entryDigits ?? defaultEntryDigits,
				consents: consents.map((consent) => ({ purpose: consent.purpose, granted: consent.granted, policyVersion: consent.policyVersion, recordedAt: consent.recordedAt })),
				// Not personal data: whether the person's identity may be published, across their purchases (S5, S9).
				winnerPublicity: publicity.length ? orderPublicity(publicity, id) : null
			};
		});
	});

	/**
	 * Records that the buyer of this order withdrew the winner publicity consent
	 * on request, as the privacy text promises (S9, Ley 25.326): a refusal with no
	 * purchase, which withdraws every earlier consent of that person. Only for
	 * admins who see personal data, since it acts on a person, not on an order.
	 * Asking again while nothing is publishable records nothing.
	 */
	app.post('/admin/orders/:id/winner-publicity/withdraw', async (request) => {
		const admin = await requireAdmin(request, 'orders.pii');
		const { id } = parse(idParams, request.params);
		return deps.db.withTenant(admin.tenant.id, async (tx) => {
			const [order] = await tx.select({ id: s.orders.id, contactId: s.orders.contactId }).from(s.orders).where(eq(s.orders.id, id));
			if (!order) throw notFound('Orden');
			const before = await publicityDecisions(tx, [order.contactId]);
			const recorded = before.length > 0 && orderPublicity(before, id).withdrawable;
			if (recorded) {
				// The version published right now, as checkout does.
				const [organization] = await tx.select({ settings: s.organizations.settings }).from(s.organizations).where(eq(s.organizations.id, admin.tenant.id));
				await tx.insert(s.contactConsents).values({
					organizationId: admin.tenant.id,
					contactId: order.contactId,
					purpose: 'winner_publicity',
					granted: false,
					policyVersion: organization!.settings.legal.privacyVersion,
					source: 'support',
					orderId: null
				});
				await audit(tx, { organizationId: admin.tenant.id, actorType: actorType(admin), actorId: admin.identity.userId, action: 'order.winner_publicity_withdrawn', targetType: 'order', targetId: id });
			}
			const after = recorded ? await publicityDecisions(tx, [order.contactId]) : before;
			return { recorded, winnerPublicity: after.length ? orderPublicity(after, id) : null };
		});
	});

	app.get('/admin/campaigns', async (request) => {
		const admin = await requireAdmin(request, 'campaigns.view');
		return deps.db.withTenant(admin.tenant.id, async (tx) => {
			const campaigns = await tx.select().from(s.campaigns).orderBy(desc(s.campaigns.createdAt));
			const entries = await tx
				.select({ campaignId: s.participationEntries.campaignId, value: count() })
				.from(s.participationEntries)
				.where(eq(s.participationEntries.status, 'eligible'))
				.groupBy(s.participationEntries.campaignId);
			return {
				campaigns: campaigns.map((campaign) => ({
					id: campaign.id,
					slug: campaign.slug,
					title: campaign.title,
					status: campaign.status,
					isDemo: campaign.isDemo,
					opensAt: campaign.opensAt,
					closesAt: campaign.closesAt,
					entries: entries.find((row) => row.campaignId === campaign.id)?.value ?? 0
				}))
			};
		});
	});

	app.get('/admin/campaigns/:id', async (request) => {
		const admin = await requireAdmin(request, 'campaigns.view');
		const { id } = parse(idParams, request.params);
		return deps.db.withTenant(admin.tenant.id, (tx) => campaignDetail(tx, id, deps.now(), deps.config.COMPLIANCE_DEMO));
	});

	app.patch('/admin/campaigns/:id', async (request) => {
		const admin = await requireAdmin(request, 'campaigns.manage');
		const { id } = parse(idParams, request.params);
		const body = parse(campaignPatch, request.body);
		return deps.db.withTenant(admin.tenant.id, async (tx) => {
			const campaign = await loadCampaign(tx, id, true);
			if (body.video) await assertOwnMedia(tx, admin.tenant.id, body.video);
			if (body.productIds?.length) {
				const found = await tx.select({ id: s.products.id }).from(s.products).where(inArray(s.products.id, body.productIds));
				if (found.length !== body.productIds.length) throw new ApiError(400, 'unknown_product', 'Elegí productos de tu catálogo');
			}
			const changesSchedule = body.opensAt || body.closesAt;
			if (changesSchedule && !['draft', 'review', 'published'].includes(campaign.status)) {
				throw new ApiError(409, 'schedule_locked', 'Las fechas quedan fijas cuando la campaña abre. Publicá una nueva versión de las bases');
			}
			const opensAt = body.opensAt ?? campaign.opensAt;
			const closesAt = body.closesAt ?? campaign.closesAt;
			if (closesAt <= opensAt) throw new ApiError(400, 'invalid_schedule', 'El cierre tiene que ser posterior a la apertura');
			await tx.update(s.campaigns).set({ ...body, updatedAt: deps.now() }).where(eq(s.campaigns.id, id));
			await audit(tx, { organizationId: admin.tenant.id, actorType: actorType(admin), actorId: admin.identity.userId, action: 'campaign.updated', targetType: 'campaign', targetId: id, metadata: { fields: Object.keys(body), ...videoChange(campaign.video, body.video) } });
			await publishOpsEvent(tx, admin.tenant.id, 'campaign.updated', id);
			return campaignDetail(tx, id, deps.now(), deps.config.COMPLIANCE_DEMO);
		});
	});

	app.post('/admin/campaigns/:id/transition', async (request) => {
		const admin = await requireAdmin(request, 'campaigns.manage');
		const { id } = parse(idParams, request.params);
		const { to } = parse(z.object({ to: z.enum(campaignStatuses) }), request.body);
		if (to === 'closed') throw new ApiError(400, 'use_close', 'Para cerrar la campaña usá la acción Cerrar y publicar manifiesto');
		return deps.db.withTenant(admin.tenant.id, async (tx) => {
			const campaign = await loadCampaign(tx, id, true);
			const [gate, locked, latest, [prizeCount], manifests] = await Promise.all([
				campaignGate(tx, campaign, deps.config.COMPLIANCE_DEMO),
				lockedRuleVersion(tx, id),
				latestRuleVersion(tx, id),
				tx.select({ value: count() }).from(s.prizes).where(eq(s.prizes.campaignId, id)),
				// The current round's manifest: each round is awarded against its own (ADR 0014 §5).
				tx
					.select({ id: s.drawManifests.id })
					.from(s.drawManifests)
					.where(and(eq(s.drawManifests.campaignId, id), eq(s.drawManifests.round, campaign.currentRound)))
			]);
			const draftToLock = !locked && latest?.status === 'draft' ? latest : null;
			const result = canTransition(campaign.status, to, {
				gate,
				hasLockedRuleVersion: Boolean(locked ?? draftToLock),
				prizeCount: prizeCount?.value ?? 0,
				opensAt: campaign.opensAt,
				closesAt: campaign.closesAt,
				now: deps.now(),
				hasPublishedManifest: manifests.length > 0,
				unresolvedAwardSlots: to === 'fulfilled' ? await unresolvedAwardSlots(tx, id) : undefined,
				vacantSlots: to === 'fulfilled' ? (await vacantSlots(tx, id)).length : undefined
			});
			if (!result.ok) throw new ApiError(409, result.reason, transitionMessage(result.reason), { missing: gate.missing, rejected: gate.rejected });

			if (to === 'open' && draftToLock) {
				// Opening freezes the essential rules (FR-CAMP-06).
				await tx
					.update(s.campaignRuleVersions)
					.set({ status: 'locked', lockedAt: deps.now(), approvedBy: admin.identity.userId, contentHash: sha256Hex(draftToLock.bodyMarkdown) })
					.where(eq(s.campaignRuleVersions.id, draftToLock.id));
			}
			await tx.update(s.campaigns).set({ status: to, updatedAt: deps.now() }).where(eq(s.campaigns.id, id));
			if (to === 'open') {
				await tx.insert(s.drawEvents).values({ organizationId: admin.tenant.id, campaignId: id, kind: 'opened', title: 'Campaña abierta y bases bloqueadas', occurredAt: deps.now(), recordedBy: admin.identity.userId });
			}
			await audit(tx, { organizationId: admin.tenant.id, actorType: actorType(admin), actorId: admin.identity.userId, action: 'campaign.transition', targetType: 'campaign', targetId: id, metadata: { from: campaign.status, to } });
			await publishOpsEvent(tx, admin.tenant.id, 'campaign.updated', id);
			return campaignDetail(tx, id, deps.now(), deps.config.COMPLIANCE_DEMO);
		});
	});

	/**
	 * Reopens an awarding campaign for a new round when its Quiniela draw left a
	 * unit vacant (ADR 0014 §5). The same gate as opening, the locked rules as
	 * they are, a new closing date, and a public announcement of what is vacant.
	 */
	app.post('/admin/campaigns/:id/reopen', async (request) => {
		const admin = await requireAdmin(request, 'campaigns.manage');
		const { id } = parse(idParams, request.params);
		const body = parse(reopenBody, request.body);
		return deps.db.withTenant(admin.tenant.id, async (tx) => {
			const campaign = await loadCampaign(tx, id, true);
			const now = deps.now();
			const [gate, locked, vacant, [draw], published] = await Promise.all([
				campaignGate(tx, campaign, deps.config.COMPLIANCE_DEMO),
				lockedRuleVersion(tx, id),
				vacantSlots(tx, id),
				tx
					.select({ id: s.quinielaDraws.id })
					.from(s.quinielaDraws)
					.where(and(eq(s.quinielaDraws.campaignId, id), eq(s.quinielaDraws.round, campaign.currentRound))),
				publishedRounds(tx, id)
			]);
			const drawAt = body.drawAt ?? null;
			const result = canReopen(campaign.status, {
				gate,
				hasLockedRuleVersion: Boolean(locked),
				roundDrawRecorded: Boolean(draw),
				// A round's results are published before the next one opens, so they stay attached to it.
				roundResultsPublished: published.has(campaign.currentRound),
				vacantSlots: vacant.length,
				now,
				closesAt: body.closesAt,
				drawAt
			});
			if (!result.ok) throw new ApiError(409, result.reason, reopenMessage(result.reason), { missing: gate.missing, rejected: gate.rejected });

			const round = campaign.currentRound + 1;
			// The previous draw date is behind us; only a newly announced one is kept.
			await tx.update(s.campaigns).set({ status: 'open', currentRound: round, closesAt: body.closesAt, drawAt, updatedAt: now }).where(eq(s.campaigns.id, id));
			const [day, time] = campaignDateTime(body.closesAt, campaign.timezone).split(' ');
			await tx.insert(s.drawEvents).values({
				organizationId: admin.tenant.id,
				campaignId: id,
				kind: 'round_opened',
				round,
				title: `Ronda ${round} abierta`,
				detail: `Cierra el ${day} a las ${time}. Premios vacantes que se sortean en esta ronda: ${vacantList(vacant)}.`,
				occurredAt: now,
				recordedBy: admin.identity.userId
			});
			await audit(tx, {
				organizationId: admin.tenant.id,
				actorType: actorType(admin),
				actorId: admin.identity.userId,
				action: 'campaign.reopened',
				targetType: 'campaign',
				targetId: id,
				metadata: { round, closesAt: body.closesAt.toISOString(), drawAt: drawAt?.toISOString() ?? null, vacant: vacant.map(({ prize, slot }) => ({ prize, slot })) }
			});
			await publishOpsEvent(tx, admin.tenant.id, 'campaign.updated', id);
			return campaignDetail(tx, id, now, deps.config.COMPLIANCE_DEMO);
		});
	});

	app.put('/admin/campaigns/:id/approvals/:kind', async (request) => {
		const admin = await requireAdmin(request, 'campaigns.approve');
		const { id, kind } = parse(z.object({ id: z.uuid(), kind: z.enum(['legal', 'psp']) }), request.params);
		const body = parse(approvalBody, request.body);
		return deps.db.withTenant(admin.tenant.id, async (tx) => {
			const campaign = await loadCampaign(tx, id, true);
			assertApprovalsEditable(campaign.status);
			const values = {
				status: body.status,
				basis: 'document' as const,
				reference: body.reference ?? null,
				authority: body.authority ?? null,
				notes: body.notes ?? null,
				decidedAt: body.status === 'pending' ? null : deps.now(),
				decidedBy: body.status === 'pending' ? null : admin.identity.userId
			};
			await tx
				.insert(s.campaignApprovals)
				.values({ organizationId: admin.tenant.id, campaignId: id, kind, ...values })
				.onConflictDoUpdate({ target: [s.campaignApprovals.campaignId, s.campaignApprovals.kind], set: values });
			await audit(tx, { organizationId: admin.tenant.id, actorType: actorType(admin), actorId: admin.identity.userId, action: 'campaign.approval_recorded', targetType: 'campaign', targetId: id, metadata: { kind, status: body.status, reference: body.reference ?? null } });
			await publishOpsEvent(tx, admin.tenant.id, 'campaign.updated', id);
			return campaignDetail(tx, id, deps.now(), deps.config.COMPLIANCE_DEMO);
		});
	});

	/**
	 * ADR 0015: the owner states that the paper documentation of every required
	 * approval exists. Approvals already recorded with a reference stay as they
	 * are; the rest become approved on paper, with no reference or authority
	 * invented. Withdrawing the statement returns only the paper ones to pending.
	 */
	app.put('/admin/campaigns/:id/paper-attestation', async (request) => {
		const admin = await requireAdmin(request, 'campaigns.approve');
		const { id } = parse(idParams, request.params);
		const { attested } = parse(paperAttestationBody, request.body);
		return deps.db.withTenant(admin.tenant.id, async (tx) => {
			const campaign = await loadCampaign(tx, id, true);
			assertApprovalsEditable(campaign.status);
			const approvals = await tx.select().from(s.campaignApprovals).where(eq(s.campaignApprovals.campaignId, id));
			const actor = { organizationId: admin.tenant.id, actorType: actorType(admin), actorId: admin.identity.userId, targetType: 'campaign', targetId: id } as const;
			if (attested) {
				const affected = campaign.requiredApprovals.filter((kind) => {
					const approval = approvals.find((candidate) => candidate.kind === kind);
					return !approval || (approval.basis !== 'paper' && !approvalSatisfied(approval));
				});
				if (affected.length > 0) {
					const values = { status: 'approved' as const, basis: 'paper' as const, decidedAt: deps.now(), decidedBy: admin.identity.userId };
					for (const kind of affected) {
						await tx
							.insert(s.campaignApprovals)
							.values({ organizationId: admin.tenant.id, campaignId: id, kind, ...values })
							.onConflictDoUpdate({ target: [s.campaignApprovals.campaignId, s.campaignApprovals.kind], set: values });
					}
					const previous = Object.fromEntries(affected.map((kind) => [kind, approvals.find((candidate) => candidate.kind === kind)?.status ?? 'pending']));
					await audit(tx, { ...actor, action: 'campaign.approvals_attested', metadata: { kinds: affected, previous } });
				}
			} else {
				const affected = approvals.filter((approval) => approval.basis === 'paper').map((approval) => approval.kind);
				if (affected.length > 0) {
					await tx
						.update(s.campaignApprovals)
						.set({ status: 'pending', basis: 'document', decidedAt: null, decidedBy: null })
						.where(and(eq(s.campaignApprovals.campaignId, id), eq(s.campaignApprovals.basis, 'paper')));
					await audit(tx, { ...actor, action: 'campaign.approvals_attestation_cleared', metadata: { kinds: [...affected].sort() } });
				}
			}
			await publishOpsEvent(tx, admin.tenant.id, 'campaign.updated', id);
			return campaignDetail(tx, id, deps.now(), deps.config.COMPLIANCE_DEMO);
		});
	});

	app.put('/admin/campaigns/:id/rules', async (request) => {
		const admin = await requireAdmin(request, 'campaigns.manage');
		const { id } = parse(idParams, request.params);
		const body = parse(rulesBody, request.body);
		return deps.db.withTenant(admin.tenant.id, async (tx) => {
			const campaign = await loadCampaign(tx, id, true);
			const decision = decideRuleChange(campaign.status, { approvedBy: admin.identity.userId, announcement: body.announcement ?? null });
			if (!decision.allowed) {
				throw new ApiError(409, decision.reason, decision.reason === 'campaign_finished' ? 'La campaña terminó; sus bases ya no cambian' : 'Con la campaña abierta, un cambio necesita un anuncio público');
			}
			const latest = await latestRuleVersion(tx, id);
			const base = latest ?? null;
			const bodyMarkdown = body.bodyMarkdown ?? base?.bodyMarkdown;
			if (!bodyMarkdown) throw new ApiError(400, 'rules_body_required', 'Cargá el texto de las bases');
			if (body.entriesPerUnit) await assertOwnVariants(tx, Object.keys(body.entriesPerUnit));
			const entryRule = {
				mode: 'per_unit' as const,
				entriesPerUnit: body.entriesPerUnit ? entriesPerUnitFromInput(body.entriesPerUnit) : (base?.entryRule.entriesPerUnit ?? {}),
				maxEntriesPerIdentity: body.maxEntriesPerIdentity === undefined ? (base?.entryRule.maxEntriesPerIdentity ?? null) : body.maxEntriesPerIdentity
			};
			const eligibility = body.eligibility ?? base?.eligibility ?? { minAge: 18, residency: 'República Argentina', excluded: [] };

			if (decision.mode === 'edit_draft' && latest?.status === 'draft') {
				await tx
					.update(s.campaignRuleVersions)
					.set({ bodyMarkdown, eligibility, entryRule, contentHash: sha256Hex(bodyMarkdown) })
					.where(eq(s.campaignRuleVersions.id, latest.id));
			} else {
				if (decision.mode === 'new_version') {
					await tx
						.update(s.campaignRuleVersions)
						.set({ status: 'superseded' })
						.where(and(eq(s.campaignRuleVersions.campaignId, id), eq(s.campaignRuleVersions.status, 'locked')));
				}
				const version = (latest?.version ?? 0) + 1;
				await tx.insert(s.campaignRuleVersions).values({
					organizationId: admin.tenant.id,
					campaignId: id,
					version,
					status: decision.mode === 'new_version' ? 'locked' : 'draft',
					bodyMarkdown,
					eligibility,
					entryRule,
					contentHash: sha256Hex(bodyMarkdown),
					lockedAt: decision.mode === 'new_version' ? deps.now() : null,
					approvedBy: decision.mode === 'new_version' ? admin.identity.userId : null,
					announcement: body.announcement ?? null
				});
				if (decision.mode === 'new_version') {
					await tx.insert(s.drawEvents).values({
						organizationId: admin.tenant.id,
						campaignId: id,
						kind: 'rules_updated',
						title: `Nueva versión ${version} de las bases`,
						detail: body.announcement ?? null,
						occurredAt: deps.now(),
						recordedBy: admin.identity.userId
					});
				}
			}
			await audit(tx, { organizationId: admin.tenant.id, actorType: actorType(admin), actorId: admin.identity.userId, action: `campaign.rules_${decision.mode}`, targetType: 'campaign', targetId: id });
			await publishOpsEvent(tx, admin.tenant.id, 'campaign.updated', id);
			return campaignDetail(tx, id, deps.now(), deps.config.COMPLIANCE_DEMO);
		});
	});

	/**
	 * Close: freeze the eligible list, publish its manifest and SHA-256 before
	 * any selection happens (DRAW-INTEGRITY 3-4). Allowed only once every order
	 * created before the close could have settled.
	 */
	app.post('/admin/campaigns/:id/close', async (request) => {
		const admin = await requireAdmin(request, 'campaigns.manage');
		const { id } = parse(idParams, request.params);
		return deps.db.withTenant(admin.tenant.id, async (tx) => {
			const campaign = await loadCampaign(tx, id, true);
			if (campaign.status !== 'open') throw new ApiError(409, 'invalid_transition', 'Solo se cierra una campaña abierta');
			const settleAt = new Date(campaign.closesAt.getTime() + ORDER_TTL_MINUTES * 60_000);
			if (deps.now() < settleAt) {
				throw new ApiError(409, 'payments_in_transit', `Se puede cerrar desde ${settleAt.toISOString()}, cuando vencen los pagos iniciados antes del cierre`);
			}
			const rule = await lockedRuleVersion(tx, id);
			const entries = await tx
				.select({ entryNumber: s.participationEntries.entryNumber, holder: s.participationEntries.holderPseudonym, status: s.participationEntries.status })
				.from(s.participationEntries)
				.where(eq(s.participationEntries.campaignId, id));
			// Every coupon of the campaign, from every round so far: they all keep playing (ADR 0014 §5).
			const round = campaign.currentRound;
			const manifest = buildManifest({ campaignId: id, round, ruleVersion: rule?.version ?? 0, entryDigits: campaign.entryDigits, closedAt: campaign.closesAt, entries });
			const content = serializeManifest(manifest);
			const hash = hashManifest(manifest);
			await tx.insert(s.drawManifests).values({
				organizationId: admin.tenant.id,
				campaignId: id,
				round,
				ruleVersion: manifest.header.ruleVersion,
				sha256: hash,
				content,
				eligibleCount: manifest.header.eligibleCount,
				voidCount: manifest.header.voidCount,
				closedAt: campaign.closesAt,
				publishedAt: deps.now()
			});
			await tx.update(s.campaigns).set({ status: 'closed', updatedAt: deps.now() }).where(eq(s.campaigns.id, id));
			await tx.insert(s.drawEvents).values({
				organizationId: admin.tenant.id,
				campaignId: id,
				kind: 'manifest_published',
				round,
				title: round > 1 ? `Lista de participaciones de la ronda ${round} congelada y publicada` : 'Lista de participaciones congelada y publicada',
				detail: `SHA-256 ${hash} · ${manifest.header.eligibleCount} participaciones válidas`,
				occurredAt: deps.now(),
				recordedBy: admin.identity.userId
			});
			await audit(tx, { organizationId: admin.tenant.id, actorType: actorType(admin), actorId: admin.identity.userId, action: 'campaign.closed', targetType: 'campaign', targetId: id, metadata: { sha256: hash, round } });
			await publishOpsEvent(tx, admin.tenant.id, 'campaign.updated', id);
			return campaignDetail(tx, id, deps.now(), deps.config.COMPLIANCE_DEMO);
		});
	});

	app.post('/admin/campaigns/:id/draw-events', async (request) => {
		const admin = await requireAdmin(request, 'campaigns.operate');
		const { id } = parse(idParams, request.params);
		const body = parse(drawEventBody, request.body);
		return deps.db.withTenant(admin.tenant.id, async (tx) => {
			const campaign = await loadCampaign(tx, id);
			// Each entry belongs to the current round. After the first, results are published only once the round's draw is recorded (ADR 0014 §5).
			if (body.kind === 'result_published' && campaign.currentRound > 1) {
				const [draw] = await tx
					.select({ id: s.quinielaDraws.id })
					.from(s.quinielaDraws)
					.where(and(eq(s.quinielaDraws.campaignId, id), eq(s.quinielaDraws.round, campaign.currentRound)));
				if (!draw) throw new ApiError(409, 'draw_pending', 'Los resultados de esta ronda se publican después de registrar su sorteo de la Quiniela');
			}
			await tx.insert(s.drawEvents).values({
				organizationId: admin.tenant.id,
				campaignId: id,
				round: campaign.currentRound,
				kind: body.kind,
				title: body.title,
				detail: body.detail ?? null,
				evidenceUrl: body.evidenceUrl ?? null,
				occurredAt: body.occurredAt,
				recordedBy: admin.identity.userId
			});
			await audit(tx, { organizationId: admin.tenant.id, actorType: actorType(admin), actorId: admin.identity.userId, action: 'campaign.draw_event', targetType: 'campaign', targetId: id, metadata: { kind: body.kind } });
			await publishOpsEvent(tx, admin.tenant.id, 'campaign.updated', id);
			return campaignDetail(tx, id, deps.now(), deps.config.COMPLIANCE_DEMO);
		});
	});

	app.get('/admin/audit', async (request) => {
		const admin = await requireAdmin(request, 'audit.view');
		const rows = await deps.db.withTenant(admin.tenant.id, (tx) => tx.select().from(s.auditEvents).orderBy(desc(s.auditEvents.createdAt)).limit(100));
		return { events: rows.map((row) => ({ action: row.action, actorType: row.actorType, targetType: row.targetType, targetId: row.targetId, metadata: row.metadata, createdAt: row.createdAt })) };
	});
}

async function loadCampaign(tx: Tx, id: string, lock = false) {
	const query = tx.select().from(s.campaigns).where(eq(s.campaigns.id, id));
	const [campaign] = lock ? await query.for('update') : await query;
	if (!campaign) throw notFound('Campaña');
	return campaign;
}

/** Chances can name only this organization's variants (RLS scopes the query to the tenant). */
async function assertOwnVariants(tx: Tx, variantIds: string[]) {
	if (variantIds.length === 0) return;
	const found = await tx.select({ id: s.productVariants.id }).from(s.productVariants).where(inArray(s.productVariants.id, variantIds));
	if (found.length !== new Set(variantIds).size) {
		throw new ApiError(400, 'unknown_variant', 'Una de las variantes no existe en el catálogo de la organización');
	}
}

async function campaignDetail(tx: Tx, id: string, now: Date, complianceDemo: boolean) {
	const campaign = await loadCampaign(tx, id);
	const catalogProducts = await tx.select({ id: s.products.id, name: s.products.name, status: s.products.status }).from(s.products).where(eq(s.products.status, 'active')).orderBy(asc(s.products.position), asc(s.products.name));
	const [gate, approvals, rules, prizes, events, manifests, [entryTotals], variants] = await Promise.all([
		campaignGate(tx, campaign, complianceDemo),
		tx.select().from(s.campaignApprovals).where(eq(s.campaignApprovals.campaignId, id)),
		tx.select().from(s.campaignRuleVersions).where(eq(s.campaignRuleVersions.campaignId, id)).orderBy(desc(s.campaignRuleVersions.version)),
		tx.select().from(s.prizes).where(eq(s.prizes.campaignId, id)).orderBy(asc(s.prizes.position)),
		tx.select().from(s.drawEvents).where(eq(s.drawEvents.campaignId, id)).orderBy(asc(s.drawEvents.occurredAt)),
		tx.select().from(s.drawManifests).where(eq(s.drawManifests.campaignId, id)),
		tx
			.select({ eligible: count(), participants: countDistinct(s.participationEntries.contactId) })
			.from(s.participationEntries)
			.where(and(eq(s.participationEntries.campaignId, id), eq(s.participationEntries.status, 'eligible'))),
		tx
			.select({ variant: s.productVariants, product: s.products })
			.from(s.productVariants)
			.innerJoin(s.products, eq(s.products.id, s.productVariants.productId))
			.orderBy(asc(s.products.position), asc(s.products.name), asc(s.productVariants.createdAt))
	]);
	// The current round's manifest, or the last one published while a new round is open.
	const manifest = [...manifests].sort((a, b) => b.round - a.round)[0];
	const vacant = await vacantSlots(tx, id);
	const published = await publishedRounds(tx, id);
	const [roundDraw] = await tx
		.select({ id: s.quinielaDraws.id })
		.from(s.quinielaDraws)
		.where(and(eq(s.quinielaDraws.campaignId, id), eq(s.quinielaDraws.round, campaign.currentRound)));
	const reopenOffered = campaign.status === 'awarding' && Boolean(roundDraw) && vacant.length > 0;
	const resultsPending = reopenOffered && !published.has(campaign.currentRound);
	// Hidden variants stay listed while they grant chances: the table saves the whole map.
	const granted = rules[0]?.entryRule.entriesPerUnit ?? {};
	const chanceVariants = variants.filter(({ variant, product }) => (product.status === 'active' && variant.active) || (granted[variant.id] ?? 0) > 0);
	return {
		id: campaign.id,
		slug: campaign.slug,
		title: campaign.title,
		subtitle: campaign.subtitle,
		summary: campaign.summary,
		status: campaign.status,
		isDemo: campaign.isDemo,
		timezone: campaign.timezone,
		opensAt: campaign.opensAt,
		closesAt: campaign.closesAt,
		drawAt: campaign.drawAt,
		streamUrl: campaign.streamUrl,
		replayUrl: campaign.replayUrl,
		video: campaign.video,
		productIds: campaign.productIds,
		// The catalog the editor chooses from, in shop order.
		products: catalogProducts.map((product) => ({ id: product.id, name: product.name, status: product.status })),
		requiredApprovals: campaign.requiredApprovals,
		gate,
		allowedTransitions: allowedTransitions(campaign.status).filter((status: CampaignStatus) => status !== 'closed'),
		canClose: campaign.status === 'open' && now >= new Date(campaign.closesAt.getTime() + ORDER_TTL_MINUTES * 60_000),
		/** ADR 0014 §5: the round being played, what is vacant, and whether a new round can start (dates and gate are checked on reopening). */
		currentRound: campaign.currentRound,
		vacantSlots: vacant.map(({ prize, slot }) => ({ prize, slot })),
		canReopen: reopenOffered && !resultsPending,
		/** Why a new round has to wait although a unit is vacant, shown next to the disabled action. */
		reopenBlocked: resultsPending ? reopenMessage('results_pending') : null,
		approvals: approvals.map((approval) => ({
			kind: approval.kind,
			status: approval.status,
			basis: approval.basis,
			reference: approval.reference,
			authority: approval.authority,
			notes: approval.notes,
			decidedAt: approval.decidedAt
		})),
		rules: rules.map((rule) => ({
			id: rule.id,
			version: rule.version,
			status: rule.status,
			bodyMarkdown: rule.bodyMarkdown,
			eligibility: rule.eligibility,
			entryRule: rule.entryRule,
			contentHash: rule.contentHash,
			lockedAt: rule.lockedAt,
			announcement: rule.announcement
		})),
		prizes: prizes.map((prize) => ({
			id: prize.id,
			position: prize.position,
			kind: prize.kind,
			title: prize.title,
			declaredValueMinor: prize.declaredValueMinor,
			quantity: prize.quantity,
			alternatesCount: prize.alternatesCount,
			mechanism: prize.mechanism
		})),
		events: events.map((event) => ({ kind: event.kind, title: event.title, detail: event.detail, evidenceUrl: event.evidenceUrl, occurredAt: event.occurredAt })),
		manifest: manifest ? { round: manifest.round, sha256: manifest.sha256, eligibleCount: manifest.eligibleCount, voidCount: manifest.voidCount, publishedAt: manifest.publishedAt } : null,
		/** Variants on sale, plus any the latest rules grant chances to, for the chances table. */
		chanceVariants: chanceVariants.map(({ variant, product }) => ({
			id: variant.id,
			name: variant.name,
			active: variant.active,
			productId: product.id,
			productName: product.name,
			productStatus: product.status
		})),
		totals: { eligibleEntries: entryTotals?.eligible ?? 0, participants: entryTotals?.participants ?? 0 }
	};
}

function transitionMessage(reason: string): string {
	const messages: Record<string, string> = {
		invalid_transition: 'Ese cambio de estado no está permitido desde el estado actual',
		compliance_gate_closed: 'Faltan aprobaciones legales o del medio de pago. La campaña no puede abrir sin ellas',
		missing_rule_version: 'Cargá las bases antes de abrir la campaña',
		missing_prizes: 'La campaña necesita al menos un premio',
		invalid_schedule: 'Revisá las fechas: el cierre tiene que ser futuro y posterior a la apertura',
		manifest_required: 'Publicá el manifiesto de cierre antes de adjudicar',
		prizes_vacant: 'Hay premios vacantes: reabrí la campaña para una nueva ronda',
		awards_pending: 'Quedan premios sin entregar o con suplentes por decidir'
	};
	return messages[reason] ?? 'No se pudo cambiar el estado';
}

function reopenMessage(reason: string): string {
	const messages: Record<string, string> = {
		invalid_transition: 'Solo se reabre una campaña en adjudicación',
		draw_pending: 'Primero registrá el sorteo de la Quiniela de esta ronda',
		no_vacancy: 'No hay premios vacantes: la campaña no necesita otra ronda',
		results_pending: 'Publicá los resultados de esta ronda antes de abrir la siguiente',
		invalid_schedule: 'Revisá las fechas: el nuevo cierre tiene que ser futuro y el sorteo, posterior al cierre',
		compliance_gate_closed: transitionMessage('compliance_gate_closed'),
		missing_rule_version: 'La campaña no tiene bases bloqueadas'
	};
	return messages[reason] ?? 'No se pudo reabrir la campaña';
}

/** "Moto", "$100.000 (unidades 2 y 3)": each vacant prize once, with its units when it has several. */
function vacantList(vacant: readonly { prizeId: string; prize: string; quantity: number; slot: number }[]): string {
	const byPrize = new Map<string, { prize: string; quantity: number; slots: number[] }>();
	for (const { prizeId, prize, quantity, slot } of vacant) {
		const entry = byPrize.get(prizeId) ?? { prize, quantity, slots: [] };
		entry.slots.push(slot);
		byPrize.set(prizeId, entry);
	}
	return [...byPrize.values()]
		.map(({ prize, quantity, slots }) =>
			quantity === 1 ? prize : `${prize} (${slots.length === 1 ? 'unidad' : 'unidades'} ${slots.slice(0, -1).join(', ')}${slots.length > 1 ? ' y ' : ''}${slots.at(-1)})`
		)
		.join(', ');
}

async function overview(tx: Tx, admin: AdminContext, now: Date) {
	const timezone = admin.tenant.timezone;
	// Read first: anything committed later arrives as an event numbered above it.
	const lastEventId = await currentSequence(tx);
	const since = new Date(now.getTime() - 14 * 86_400_000);
	const [
		[sales],
		[refunds],
		[pending],
		[participation],
		[committed],
		[delivered],
		daily,
		recent,
		[mismatches],
		[oversold],
		[unreconciled]
	] = await Promise.all([
		tx.select({ total: sum(s.orders.totalMinor), orders: count() }).from(s.orders).where(eq(s.orders.status, 'paid')),
		tx.select({ total: sum(s.orders.totalMinor) }).from(s.orders).where(inArray(s.orders.status, ['refunded', 'charged_back'])),
		tx.select({ value: count() }).from(s.orders).where(and(eq(s.orders.status, 'pending_payment'), gt(s.orders.expiresAt, now))),
		tx
			.select({ entries: count(), participants: countDistinct(s.participationEntries.contactId) })
			.from(s.participationEntries)
			.where(eq(s.participationEntries.status, 'eligible')),
		tx
			.select({ total: sql<string>`coalesce(sum(${s.prizes.declaredValueMinor} * ${s.prizes.quantity}), 0)` })
			.from(s.prizes)
			.innerJoin(s.campaigns, eq(s.campaigns.id, s.prizes.campaignId))
			.where(inArray(s.campaigns.status, ['open', 'closed', 'awarding'])),
		tx
			.select({ total: sql<string>`coalesce(sum(${s.prizes.declaredValueMinor}), 0)` })
			.from(s.prizeFulfillments)
			.innerJoin(s.prizeAwards, eq(s.prizeAwards.id, s.prizeFulfillments.awardId))
			.innerJoin(s.prizes, eq(s.prizes.id, s.prizeAwards.prizeId))
			.where(eq(s.prizeFulfillments.status, 'delivered')),
		tx
			.select({
				day: sql<string>`to_char(date_trunc('day', ${s.orders.paidAt} at time zone ${timezone}), 'YYYY-MM-DD')`,
				total: sum(s.orders.totalMinor),
				orders: count()
			})
			.from(s.orders)
			.where(and(eq(s.orders.status, 'paid'), gt(s.orders.paidAt, since)))
			.groupBy(sql`1`)
			.orderBy(sql`1`),
		tx.select().from(s.orders).orderBy(desc(s.orders.updatedAt)).limit(8),
		tx
			.select({ value: count() })
			.from(s.auditEvents)
			.where(and(eq(s.auditEvents.action, 'payment.rejected_mismatch'), gt(s.auditEvents.createdAt, new Date(now.getTime() - 7 * 86_400_000)))),
		tx.select({ value: count() }).from(s.auditEvents).where(eq(s.auditEvents.action, 'stock.oversold')),
		tx
			.select({ value: count() })
			.from(s.reconciliationItems)
			.where(and(eq(s.reconciliationItems.status, 'open'), eq(s.reconciliationItems.severity, 'critical')))
	]);
	const grossMinor = Number(sales?.total ?? 0);
	const refundedMinor = Number(refunds?.total ?? 0);
	const prizesCommittedMinor = Number(committed?.total ?? 0);
	return {
		generatedAt: now.toISOString(),
		lastEventId,
		kpis: {
			grossApprovedMinor: grossMinor,
			paidOrders: sales?.orders ?? 0,
			pendingOrders: pending?.value ?? 0,
			refundedMinor,
			participants: participation?.participants ?? 0,
			entries: participation?.entries ?? 0,
			prizesCommittedMinor,
			prizesDeliveredMinor: Number(delivered?.total ?? 0),
			// Estimate only: provider fees and settlements are not known until reconciliation (FR-PAY-06).
			projectedNetMinor: grossMinor - refundedMinor - prizesCommittedMinor
		},
		daily: fillDays(daily.map((row) => ({ day: row.day, totalMinor: Number(row.total ?? 0), orders: row.orders })), now, timezone),
		recent: recent.map((order) => ({
			reference: order.reference,
			status: order.status,
			totalMinor: order.totalMinor,
			buyer: `${order.buyer.firstName} ${order.buyer.lastName.slice(0, 1)}.`,
			updatedAt: order.updatedAt
		})),
		alerts: [
			...(mismatches?.value ? [{ kind: 'payment_mismatch', count: mismatches.value, message: 'Pagos rechazados por no coincidir con la orden en los últimos 7 días' }] : []),
			...(oversold?.value ? [{ kind: 'oversold', count: oversold.value, message: 'Órdenes pagadas sin stock suficiente' }] : []),
			...(unreconciled?.value ? [{ kind: 'reconciliation', count: unreconciled.value, message: 'Diferencias críticas de conciliación sin resolver' }] : [])
		]
	};
}

function fillDays(rows: { day: string; totalMinor: number; orders: number }[], now: Date, timezone: string) {
	const format = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
	const result: { day: string; totalMinor: number; orders: number }[] = [];
	for (let offset = 13; offset >= 0; offset--) {
		const day = format.format(new Date(now.getTime() - offset * 86_400_000));
		result.push(rows.find((row) => row.day === day) ?? { day, totalMinor: 0, orders: 0 });
	}
	return result;
}
