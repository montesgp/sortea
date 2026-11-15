import { and, asc, eq, publishOpsEvent, schema as s, sql, type Tx } from '@sortea/db';
import { buildManifest, serializeManifest } from '@sortea/domain';
import { hashManifest, holderPseudonym } from '@sortea/domain/server';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { actorType, requireAdminAny } from '../lib/admin-context';
import { audit } from '../lib/audit';
import { lockedRuleVersion } from '../lib/campaign-state';
import { ApiError, notFound, parse } from '../lib/errors';
import type { AppDeps } from '../context';
import { drawRoomStatuses } from './draw-room';

/**
 * "Reiniciar ensayo" (owner feedback 2026-11-14, S5 and L2; ADR 0026 §7). Draws are append-only,
 * so a demo campaign's draw is rehearsed again on a copy: the campaign, its prizes, its locked
 * rules and its coupons, without any tirada or award, with its own manifest published. Only
 * outside production and only for campaigns marked as demo; the source is never touched.
 */

type Campaign = typeof s.campaigns.$inferSelect;

/**
 * Whether this deployment may reset rehearsals: staging, or local development and tests (the
 * variable unset or `development` in a build that is not production). Production, and a
 * production build that does not say where it runs, never.
 */
export function rehearsalResetAllowed(config: Pick<AppDeps['config'], 'NODE_ENV' | 'DEPLOY_ENVIRONMENT'>): boolean {
	const environment = config.DEPLOY_ENVIRONMENT;
	if (environment === 'staging') return true;
	return (environment === undefined || environment === 'development') && config.NODE_ENV !== 'production';
}

/** The room's "Reiniciar ensayo" shows for a demo campaign where the API would copy it. */
export function rehearsalView(config: AppDeps['config'], campaign: Pick<Campaign, 'isDemo' | 'status'>) {
	return { resettable: rehearsalResetAllowed(config) && campaign.isDemo && (drawRoomStatuses as readonly string[]).includes(campaign.status) };
}

const COPY_SUFFIX = /-ensayo-\d+$/;
const TITLE_SUFFIX = / \(ensayo \d+\)$/;

/** The next rehearsal number of a campaign family: one more than the highest `<slug>-ensayo-<n>` there is. */
async function nextRehearsal(tx: Tx, baseSlug: string): Promise<number> {
	const rows = await tx.select({ slug: s.campaigns.slug }).from(s.campaigns).where(sql`${s.campaigns.slug} like ${`${baseSlug.replace(/[\\%_]/g, '\\$&')}-ensayo-%`}`);
	const taken = rows.map((row) => Number(row.slug.slice(baseSlug.length + '-ensayo-'.length))).filter((n) => Number.isInteger(n) && n > 0);
	return Math.max(0, ...taken) + 1;
}

/**
 * The copy, in the caller's transaction. Coupons point to the same contacts and orders: the
 * orders stay the source's, so no sale, payment or revenue is duplicated; each coupon gets the
 * copy's pseudonym, as the manifest of a campaign does.
 */
async function copyRehearsal(tx: Tx, deps: AppDeps, source: Campaign, actor: { organizationId: string; actorType: 'admin' | 'platform_admin'; userId: string }) {
	const now = deps.now();
	const baseSlug = source.slug.replace(COPY_SUFFIX, '');
	const n = await nextRehearsal(tx, baseSlug);
	const slug = `${baseSlug}-ensayo-${n}`;
	const title = `${source.title.replace(TITLE_SUFFIX, '')} (ensayo ${n})`;
	// The same dates, moved back so the close is already past when it is not.
	const closesAt = source.closesAt ?? now;
	const shift = closesAt < now ? 0 : now.getTime() - 60_000 - closesAt.getTime();
	const moved = (date: Date | null) => (date ? new Date(date.getTime() + shift) : null);

	const [copy] = await tx
		.insert(s.campaigns)
		.values({
			organizationId: source.organizationId,
			slug,
			title,
			subtitle: source.subtitle,
			summary: source.summary,
			status: 'awarding',
			timezone: source.timezone,
			opensAt: moved(source.opensAt),
			closesAt: moved(closesAt),
			drawAt: moved(source.drawAt),
			streamUrl: source.streamUrl,
			modality: source.modality,
			authority: source.authority,
			requiredApprovals: source.requiredApprovals,
			isDemo: true,
			nextEntryNumber: source.nextEntryNumber,
			entryDigits: source.entryDigits,
			awardOrder: source.awardOrder,
			seo: source.seo,
			video: source.video,
			productIds: source.productIds
		})
		.returning();
	const id = copy!.id;
	const organizationId = source.organizationId;

	// Approvals are recorded by a person (ADR 0015): the copy's start pending, whatever the source's are.
	if (source.requiredApprovals.length > 0) {
		await tx.insert(s.campaignApprovals).values(source.requiredApprovals.map((kind) => ({ organizationId, campaignId: id, kind, status: 'pending' as const })));
	}
	const rule = await lockedRuleVersion(tx, source.id);
	if (rule) {
		const { id: _id, campaignId: _campaignId, createdAt: _createdAt, ...fields } = rule;
		await tx.insert(s.campaignRuleVersions).values({ ...fields, campaignId: id });
	}
	const [prizes, media, faqs, entries] = await Promise.all([
		tx.select().from(s.prizes).where(eq(s.prizes.campaignId, source.id)).orderBy(asc(s.prizes.position)),
		tx.select().from(s.campaignMedia).where(eq(s.campaignMedia.campaignId, source.id)),
		tx.select().from(s.campaignFaqs).where(eq(s.campaignFaqs.campaignId, source.id)),
		tx.select().from(s.participationEntries).where(eq(s.participationEntries.campaignId, source.id)).orderBy(asc(s.participationEntries.entryNumber))
	]);
	if (prizes.length) await tx.insert(s.prizes).values(prizes.map(({ id: _id, createdAt: _createdAt, ...prize }) => ({ ...prize, campaignId: id })));
	if (media.length) await tx.insert(s.campaignMedia).values(media.map(({ id: _id, createdAt: _createdAt, ...item }) => ({ ...item, campaignId: id })));
	if (faqs.length) await tx.insert(s.campaignFaqs).values(faqs.map(({ id: _id, ...faq }) => ({ ...faq, campaignId: id })));

	const copied = entries.length
		? await tx
				.insert(s.participationEntries)
				.values(
					entries.map((entry) => ({
						organizationId,
						campaignId: id,
						entryNumber: entry.entryNumber,
						contactId: entry.contactId,
						orderId: entry.orderId,
						holderPseudonym: holderPseudonym(deps.config.PSEUDONYM_PEPPER, id, entry.contactId),
						status: entry.status
					}))
				)
				.returning()
		: [];
	if (copied.length) {
		await tx.insert(s.entryLedgerEvents).values(
			copied.map((entry) => ({ organizationId, campaignId: id, entryId: entry.id, event: 'allocated' as const, reason: `Copia del ensayo de ${source.slug}`, orderId: entry.orderId }))
		);
	}

	// Closed and frozen at once, as the close does (DRAW-INTEGRITY 3-4): its manifest and SHA-256 are public before any draw.
	const manifest = buildManifest({
		campaignId: id,
		round: 1,
		ruleVersion: rule?.version ?? 0,
		entryDigits: copy!.entryDigits,
		closedAt: copy!.closesAt!,
		entries: copied.map((entry) => ({ entryNumber: entry.entryNumber, holder: entry.holderPseudonym, status: entry.status }))
	});
	const hash = hashManifest(manifest);
	await tx.insert(s.drawManifests).values({
		organizationId,
		campaignId: id,
		round: 1,
		ruleVersion: manifest.header.ruleVersion,
		sha256: hash,
		content: serializeManifest(manifest),
		eligibleCount: manifest.header.eligibleCount,
		voidCount: manifest.header.voidCount,
		closedAt: copy!.closesAt!,
		publishedAt: now
	});
	await tx.insert(s.drawEvents).values({
		organizationId,
		campaignId: id,
		kind: 'manifest_published',
		round: 1,
		title: 'Lista de participaciones congelada y publicada',
		detail: `SHA-256 ${hash} · ${manifest.header.eligibleCount} participaciones válidas`,
		occurredAt: now,
		recordedBy: actor.userId
	});
	await audit(tx, {
		organizationId,
		actorType: actor.actorType,
		actorId: actor.userId,
		action: 'campaign.rehearsal_reset',
		targetType: 'campaign',
		targetId: id,
		metadata: { sourceCampaignId: source.id, campaignId: id, sha256: hash }
	});
	await publishOpsEvent(tx, organizationId, 'campaign.updated', id);
	return { id, slug, title };
}

export async function rehearsalRoutes(app: FastifyInstance) {
	const { deps } = app;

	/** "Reiniciar ensayo": the draw host and the roles that operate campaigns; 404 where rehearsals cannot be reset. */
	app.post('/admin/campaigns/:id/rehearsal/reset', async (request, reply) => {
		const admin = await requireAdminAny(request, ['draws.run', 'campaigns.operate']);
		const { id } = parse(z.object({ id: z.uuid() }), request.params);
		if (!rehearsalResetAllowed(deps.config)) throw notFound();
		const created = await deps.db.withTenant(admin.tenant.id, async (tx) => {
			const [source] = await tx
				.select()
				.from(s.campaigns)
				.where(and(eq(s.campaigns.id, id), eq(s.campaigns.organizationId, admin.tenant.id)))
				.for('update');
			if (!source || !(drawRoomStatuses as readonly string[]).includes(source.status)) throw notFound('Campaña');
			if (!source.isDemo) throw new ApiError(409, 'not_a_rehearsal', 'Solo se reinicia el ensayo de una campaña de prueba');
			return copyRehearsal(tx, deps, source, { organizationId: admin.tenant.id, actorType: actorType(admin), userId: admin.identity.userId });
		});
		return reply.code(201).send(created);
	});
}
