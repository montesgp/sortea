import { and, asc, count, countDistinct, desc, eq, inArray, isNotNull, isNull, ne, or, schema as s, type Tx } from '@sortea/db';
import { acceptsParticipations, appDrawCandidateText, comparePrizes, padEntryNumber, publicContact, publicSocial, resolveMediaRefs, resolveVideo, themeToCss, vacantQuinielaSlots } from '@sortea/domain';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { campaignGate, couponsRemaining, demoPayments, latestRuleVersion, lockedRuleVersion, participationCampaign } from '../lib/campaign-state';
import { notFound, parse } from '../lib/errors';
import { requireTenant, resolvedTheme } from '../lib/tenant';
import { campaignAppDraws } from './app-draw';
import { awardSource, prizeOrder, slotVoids } from './awards';
import { listPublicCatalog } from './catalog';
import { publicWinners } from './winners';

const slugParams = z.object({ slug: z.string().regex(/^[a-z0-9-]{1,80}$/) });
const listedStatuses = ['published', 'open', 'closed', 'awarding', 'fulfilled'] as const;

/**
 * Public, cacheable reads. Nothing here returns personal data: winners and
 * participations are shown by entry number and pseudonym only (FR-ENTRY-05).
 * The one exception is a winner who consented to be named (S5): name, city and
 * chances, never document, email, phone or address (see ./winners).
 */
export async function publicRoutes(app: FastifyInstance) {
	const { deps } = app;
	/** Uploads become their public bucket URL and links the privacy-enhanced YouTube embed (S9). */
	const video = (value: string | null) => resolveVideo(value, deps.media.publicUrl);
	/** A library image becomes its public bucket URL; paths and https URLs stay as they are (S2, 2026-10-22). */
	const image = (value: string | null) => resolveMediaRefs(value, deps.media.publicUrl);

	app.get('/public/site', async (request) => {
		const tenant = await requireTenant(request);
		const { tokens, issues } = resolvedTheme(tenant);
		const blocks = await deps.db.withTenant(tenant.id, (tx) => tx.select().from(s.cmsBlocks));
		const faqs = await deps.db.withTenant(tenant.id, (tx) =>
			tx.select().from(s.campaignFaqs).where(isNull(s.campaignFaqs.campaignId)).orderBy(asc(s.campaignFaqs.position))
		);
		// Fresh, not from the tenant cache: legal pages must label their text with the version checkout records.
		const [organization] = await deps.db.withTenant(tenant.id, (tx) => tx.select({ settings: s.organizations.settings }).from(s.organizations));
		const legal = organization!.settings.legal;
		const payments = await deps.db.withTenant(tenant.id, (tx) => demoPayments(tx, tenant.id, deps.config.COMPLIANCE_DEMO));
		const content = Object.fromEntries(
			blocks.filter((block) => block.publishedAt && block.content).map((block) => [block.key, resolveMediaRefs(block.content, deps.media.publicUrl)])
		);
		return {
			organization: { name: tenant.name, slug: tenant.slug, locale: tenant.locale, timezone: tenant.timezone, currency: tenant.currency },
			theme: { css: themeToCss(tokens), defaultMode: tokens.defaultMode, contrastFallbacks: issues.length },
			content,
			contact: publicContact(tenant.settings.contact),
			social: publicSocial(tenant.settings.social),
			delivery: tenant.settings.delivery,
			legal: { termsVersion: legal.termsVersion, privacyVersion: legal.privacyVersion },
			faqs: faqs.map((faq) => ({ id: faq.id, question: faq.question, answer: faq.answer })),
			// Every public page says so while the compliance demo mode can waive approvals, i.e. the
			// active account is a test account, and on what payments it runs (ADR 0013).
			complianceDemo: payments !== null,
			demoPayments: payments,
			serverTime: deps.now().toISOString()
		};
	});

	app.get('/public/products', async (request) => {
		const tenant = await requireTenant(request);
		return deps.db.withTenant(tenant.id, async (tx) => {
			const [products, participation] = await Promise.all([listPublicCatalog(tx), participationCampaign(tx, deps.now(), deps.config.COMPLIANCE_DEMO)]);
			// A sold-out campaign promises no chances (ADR 0014 §1).
			const soldOut = participation ? (await couponsRemaining(tx, participation.campaign, deps.now())) === 0 : false;
			return {
				products,
				// Chances per unit only from the locked rules of the campaign accepting participations (FR-CAMP-05).
				chances: participation && !soldOut
					? {
							campaign: { slug: participation.campaign.slug, title: participation.campaign.title },
							perUnit: participation.rule.entryRule.entriesPerUnit,
							maxPerIdentity: participation.rule.entryRule.maxEntriesPerIdentity
						}
					: null
			};
		});
	});

	app.get('/public/campaigns', async (request) => {
		const tenant = await requireTenant(request);
		return deps.db.withTenant(tenant.id, async (tx) => {
			const campaigns = await tx
				.select()
				.from(s.campaigns)
				.where(inArray(s.campaigns.status, [...listedStatuses]))
				.orderBy(desc(s.campaigns.closesAt));
			const prizes = campaigns.length
				? await tx.select().from(s.prizes).where(inArray(s.prizes.campaignId, campaigns.map((campaign) => campaign.id))).orderBy(asc(s.prizes.position))
				: [];
			return {
				campaigns: campaigns.map((campaign) => ({
					slug: campaign.slug,
					title: campaign.title,
					subtitle: campaign.subtitle,
					summary: campaign.summary,
					status: campaign.status,
					isDemo: campaign.isDemo,
					opensAt: campaign.opensAt,
					closesAt: campaign.closesAt,
					drawAt: campaign.drawAt,
					video: video(campaign.video),
					mainPrize: prizes.find((prize) => prize.campaignId === campaign.id)?.title ?? null,
					prizeCount: prizes.filter((prize) => prize.campaignId === campaign.id).reduce((sum, prize) => sum + prize.quantity, 0),
					// The public face of each prize, for the campaign block on the home and the shop (S8).
					prizes: prizes
						.filter((prize) => prize.campaignId === campaign.id)
						.map((prize) => ({ position: prize.position, kind: prize.kind, title: prize.title, quantity: prize.quantity, imageUrl: image(prize.imageUrl), video: video(prize.video) }))
				})),
				serverTime: deps.now().toISOString()
			};
		});
	});

	app.get('/public/campaigns/:slug', async (request) => {
		const tenant = await requireTenant(request);
		const { slug } = slugParams.parse(request.params);
		return deps.db.withTenant(tenant.id, async (tx) => {
			const campaign = await findListedCampaign(tx, slug);
			const gate = await campaignGate(tx, campaign, deps.config.COMPLIANCE_DEMO);
			const [prizes, media, faqs, approvals, locked, latest, winners, winnersTable, voids] = await Promise.all([
				tx.select().from(s.prizes).where(eq(s.prizes.campaignId, campaign.id)).orderBy(asc(s.prizes.position)),
				tx.select().from(s.campaignMedia).where(eq(s.campaignMedia.campaignId, campaign.id)).orderBy(asc(s.campaignMedia.position)),
				tx.select().from(s.campaignFaqs).where(eq(s.campaignFaqs.campaignId, campaign.id)).orderBy(asc(s.campaignFaqs.position)),
				tx.select().from(s.campaignApprovals).where(eq(s.campaignApprovals.campaignId, campaign.id)),
				lockedRuleVersion(tx, campaign.id),
				latestRuleVersion(tx, campaign.id),
				tx
					.select({ prizeId: s.prizeAwards.prizeId, slot: s.prizeAwards.slot, round: s.prizeAwards.round })
					.from(s.prizeAwards)
					.where(and(eq(s.prizeAwards.campaignId, campaign.id), eq(s.prizeAwards.role, 'winner'))),
				publicWinners(tx, campaign.id),
				slotVoids(tx, campaign.id)
			]);
			const rules = locked ?? latest;
			// What earlier rounds left vacant, as announced when the campaign reopened; this round's own draw stays out until its results are (ADR 0014 §5).
			const carriedOver =
				campaign.currentRound > 1
					? vacantQuinielaSlots([...prizes].sort(comparePrizes), winners, campaign.currentRound - 1, voids).map(({ prize, slot }) => ({ prize: prize.title, slot }))
					: [];
			const remaining = await couponsRemaining(tx, campaign, deps.now());
			// With no coupons left the page stops promising chances (ADR 0014 §1).
			const soldOut = remaining === 0;
			const promised = locked && !soldOut ? locked.entryRule : null;
			const qualifyingVariants = promised ? Object.keys(promised.entriesPerUnit) : [];
			return {
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
				video: video(campaign.video),
				// Products its page shows; empty means every active product (2026-10-18b).
				productIds: campaign.productIds,
				modality: campaign.modality,
				authority: campaign.authority,
				seo: campaign.seo,
				acceptingParticipations: acceptsParticipations(campaign.status, gate, campaign, deps.now()),
				round: campaign.currentRound,
				carriedOver,
				compliance: {
					allowed: gate.allowed,
					demo: gate.demo === true,
					approvals: approvals.map((approval) => ({
						kind: approval.kind,
						status: approval.status,
						// `paper`: the owner attested the paper documentation, so there is no reference to show (ADR 0015).
						basis: approval.status === 'approved' ? approval.basis : null,
						authority: approval.status === 'approved' ? approval.authority : null,
						reference: approval.status === 'approved' ? approval.reference : null,
						decidedAt: approval.status === 'approved' ? approval.decidedAt : null
					}))
				},
				rules: rules
					? { version: rules.version, status: rules.status, body: rules.bodyMarkdown, eligibility: rules.eligibility, contentHash: rules.contentHash, lockedAt: rules.lockedAt }
					: null,
				qualifyingVariants,
				chancesPerUnit: promised ? promised.entriesPerUnit : {},
				maxChancesPerIdentity: promised ? promised.maxEntriesPerIdentity : null,
				entryDigits: campaign.entryDigits,
				couponsRemaining: remaining,
				soldOut,
				prizes: prizes.map((prize) => ({
					position: prize.position,
					kind: prize.kind,
					title: prize.title,
					description: prize.description,
					declaredValueMinor: prize.declaredValueMinor,
					currency: prize.currency,
					quantity: prize.quantity,
					conditions: prize.conditions,
					imageUrl: image(prize.imageUrl),
					video: video(prize.video)
				})),
				media: media.map((item) => ({ kind: item.kind, role: item.role, url: item.url, alt: item.alt })),
				faqs: faqs.map((faq) => ({ question: faq.question, answer: faq.answer })),
				/** Null until a round's results are published (S5). */
				winners: winnersTable,
				serverTime: deps.now().toISOString()
			};
		});
	});

	app.get('/public/campaigns/:slug/transparency', async (request) => {
		const tenant = await requireTenant(request);
		const { slug } = slugParams.parse(request.params);
		return deps.db.withTenant(tenant.id, async (tx) => {
			const campaign = await findListedCampaign(tx, slug);
			const [[totals], [voided], rules, manifests, events, awards, prizes, draws, appDraws, voids] = await Promise.all([
				tx
					.select({ entries: count(), participants: countDistinct(s.participationEntries.contactId) })
					.from(s.participationEntries)
					.where(and(eq(s.participationEntries.campaignId, campaign.id), eq(s.participationEntries.status, 'eligible'))),
				tx
					.select({ value: count() })
					.from(s.participationEntries)
					.where(and(eq(s.participationEntries.campaignId, campaign.id), eq(s.participationEntries.status, 'void'))),
				tx
					.select()
					.from(s.campaignRuleVersions)
					.where(and(eq(s.campaignRuleVersions.campaignId, campaign.id), ne(s.campaignRuleVersions.status, 'draft')))
					.orderBy(asc(s.campaignRuleVersions.version)),
				tx.select().from(s.drawManifests).where(eq(s.drawManifests.campaignId, campaign.id)),
				tx.select().from(s.drawEvents).where(eq(s.drawEvents.campaignId, campaign.id)).orderBy(asc(s.drawEvents.occurredAt)),
				tx
					.select({ award: s.prizeAwards, prize: s.prizes, entryNumber: s.participationEntries.entryNumber, fulfillment: s.prizeFulfillments })
					.from(s.prizeAwards)
					.innerJoin(s.prizes, eq(s.prizes.id, s.prizeAwards.prizeId))
					.leftJoin(s.participationEntries, eq(s.participationEntries.id, s.prizeAwards.entryId))
					.leftJoin(s.prizeFulfillments, eq(s.prizeFulfillments.awardId, s.prizeAwards.id))
					.where(and(eq(s.prizeAwards.campaignId, campaign.id), or(eq(s.prizeAwards.role, 'winner'), eq(s.prizeAwards.status, 'accepted'))))
					.orderBy(...prizeOrder, asc(s.prizeAwards.slot), asc(s.prizeAwards.rank)),
				tx.select().from(s.prizes).where(eq(s.prizes.campaignId, campaign.id)).orderBy(...prizeOrder),
				tx.select().from(s.quinielaDraws).where(eq(s.quinielaDraws.campaignId, campaign.id)).orderBy(asc(s.quinielaDraws.round)),
				campaignAppDraws(tx, campaign.id),
				slotVoids(tx, campaign.id)
			]);
			// One manifest per round, each with its own hash (ADR 0014 §5).
			const published = manifests.filter((candidate) => candidate.publishedAt).sort((a, b) => a.round - b.round);
			const manifest = published.at(-1);
			// A round's results become public with its "result published" entry of the log, never while being verified.
			const publishedRounds = new Set(events.filter((event) => event.kind === 'result_published').map((event) => event.round));
			// The extract that matched a quiniela coupon in its round's draw: its first appearance, since repeats are skipped (ADR 0014 §4).
			const extractPosition = (source: string, round: number, entryNumber: number | null) => {
				if (source !== 'quiniela' || entryNumber === null) return null;
				const index = draws.find((draw) => draw.round === round)?.extracts.indexOf(entryNumber) ?? -1;
				return index === -1 ? null : index + 1;
			};
			const winners = awards.filter(({ award }) => award.role === 'winner').map(({ award }) => award);
			// The units each drawn round left without a winner, once that round's results are published.
			const vacantSlots = draws
				.filter((draw) => publishedRounds.has(draw.round))
				.flatMap((draw) => vacantQuinielaSlots(prizes, winners, draw.round, voids).map(({ prize, slot }) => ({ round: draw.round, prize: prize.title, slot })));
			// Units declared void ("Desierto", T13), with their reason, once the round they were declared in has its results published; in prize order.
			const voidSlots = prizes.flatMap((prize) =>
				voids
					.filter((row) => row.prizeId === prize.id && publishedRounds.has(row.round))
					.sort((a, b) => a.slot - b.slot)
					.map((row) => ({ round: row.round, prize: prize.title, slot: row.slot, reason: row.reason, declaredAt: row.declaredAt }))
			);
			return {
				slug: campaign.slug,
				title: campaign.title,
				status: campaign.status,
				isDemo: campaign.isDemo,
				closesAt: campaign.closesAt,
				drawAt: campaign.drawAt,
				streamUrl: campaign.streamUrl,
				replayUrl: campaign.replayUrl,
				entryDigits: campaign.entryDigits,
				round: campaign.currentRound,
				totals: { eligibleEntries: totals?.entries ?? 0, participants: totals?.participants ?? 0, voidedEntries: voided?.value ?? 0 },
				ruleVersions: rules.map((rule) => ({
					version: rule.version,
					status: rule.status,
					lockedAt: rule.lockedAt,
					contentHash: rule.contentHash,
					announcement: rule.announcement
				})),
				/** The latest published manifest. */
				manifest: manifest ? publicManifest(manifest) : null,
				manifests: published.map(publicManifest),
				timeline: events.map((event) => ({ round: event.round, kind: event.kind, title: event.title, detail: event.detail, evidenceUrl: event.evidenceUrl, occurredAt: event.occurredAt })),
				// The official draw is public as soon as it is recorded: anyone can match it against the manifest (S4).
				quinielaDraws: draws.map((draw) => ({
					round: draw.round,
					source: draw.source,
					drawnAt: draw.drawnAt,
					extracts: draw.extracts,
					evidenceUrl: draw.evidenceUrl,
					manifestSha256: draw.manifestSha256,
					recordedAt: draw.createdAt
				})),
				// The in-app draw of each round's vacancies (ADR 0024): its count and hash at once, its picks with the round's results.
				// The candidate list itself is the plain-text file below, not inlined: it can hold thousands of coupons (T13).
				appDraws: appDraws.map((draw) => ({
					round: draw.round,
					drawnAt: draw.drawnAt,
					candidateCount: draw.candidateCount,
					candidateSha256: draw.candidateSha256,
					picks: publishedRounds.has(draw.round)
						? draw.picks.map((pick) => ({
								prize: prizes.find((prize) => prize.id === pick.prizeId)?.title ?? '',
								slot: pick.slot,
								role: pick.role,
								rank: pick.rank,
								entryNumber: padEntryNumber(pick.entryNumber, campaign.entryDigits)
							}))
						: null
				})),
				awards: awards.filter(({ award }) => publishedRounds.has(award.round)).map(({ award, prize, entryNumber, fulfillment }) => ({
					round: award.round,
					prize: prize.title,
					slot: award.slot,
					role: award.role,
					status: award.status,
					/** `app_draw` is labelled "Sorteo en la app" (ADR 0024). */
					source: awardSource(award, prize),
					entryNumber,
					extractPosition: extractPosition(awardSource(award, prize), award.round, entryNumber),
					fulfillment: fulfillment ? { status: fulfillment.status, deliveredAt: fulfillment.deliveredAt, evidenceUrl: fulfillment.evidenceUrl } : null
				})),
				/** Quiniela units each round's draw left without a match, once that round's results are published; not those declared void. */
				vacantSlots,
				/** Units declared void ("Desierto") with their reason, once that round's results are published (T13). */
				voidSlots
			};
		});
	});

	/**
	 * The candidate coupons of a round's in-app draw (ADR 0024 §2, §6; T13): exactly
	 * the canonical text the draw hashed, one number per line and no final
	 * newline, so `sha256sum` of the download equals the published `candidateSha256`.
	 * Numbers only, no names. The record is append-only, so the file never changes.
	 */
	app.get('/public/campaigns/:slug/app-draws/:round/candidates.txt', async (request, reply) => {
		const tenant = await requireTenant(request);
		const { slug, round } = parse(appDrawParams, request.params);
		const found = await deps.db.withTenant(tenant.id, async (tx) => {
			const campaign = await findListedCampaign(tx, slug);
			const [draw] = await tx
				.select({ candidates: s.appDraws.candidates, candidateSha256: s.appDraws.candidateSha256 })
				.from(s.appDraws)
				.where(and(eq(s.appDraws.campaignId, campaign.id), eq(s.appDraws.round, round)));
			return draw ? { draw, entryDigits: campaign.entryDigits } : null;
		});
		if (!found) throw notFound('Sorteo en la app');
		return reply
			.header('content-type', 'text/plain; charset=utf-8')
			.header('content-disposition', `attachment; filename="${slug}-cupones-sorteo-app-ronda-${round}.txt"`)
			.header('x-content-sha256', found.draw.candidateSha256)
			.header('cache-control', 'public, max-age=3600')
			.send(appDrawCandidateText(found.draw.candidates, found.entryDigits));
	});

	/** A published manifest, byte for byte, so anyone can recompute its SHA-256 (AC-11): the given round's, or the latest. */
	app.get('/public/campaigns/:slug/manifest', async (request, reply) => {
		const tenant = await requireTenant(request);
		const { slug } = slugParams.parse(request.params);
		const { round } = manifestQuery.parse(request.query);
		const manifest = await deps.db.withTenant(tenant.id, async (tx) => {
			const campaign = await findListedCampaign(tx, slug);
			const [row] = await tx
				.select()
				.from(s.drawManifests)
				.where(and(eq(s.drawManifests.campaignId, campaign.id), round ? eq(s.drawManifests.round, round) : undefined, isNotNull(s.drawManifests.publishedAt)))
				.orderBy(desc(s.drawManifests.round))
				.limit(1);
			return row ?? null;
		});
		if (!manifest) throw notFound('Manifiesto');
		return reply
			.header('content-type', 'application/x-ndjson; charset=utf-8')
			.header('content-disposition', `attachment; filename="${slug}-manifest.ndjson"`)
			.header('x-content-sha256', manifest.sha256)
			.send(manifest.content);
	});
}

const appDrawParams = slugParams.extend({ round: z.coerce.number().int().min(1).max(10_000) });

const manifestQuery = z.object({ round: z.coerce.number().int().min(1).max(10_000).optional() });

function publicManifest(manifest: typeof s.drawManifests.$inferSelect) {
	return {
		round: manifest.round,
		sha256: manifest.sha256,
		eligibleCount: manifest.eligibleCount,
		voidCount: manifest.voidCount,
		closedAt: manifest.closedAt,
		publishedAt: manifest.publishedAt
	};
}

async function findListedCampaign(tx: Tx, slug: string) {
	const [campaign] = await tx
		.select()
		.from(s.campaigns)
		// A draft archived before it had dates was never shown, so it stays hidden.
		.where(and(eq(s.campaigns.slug, slug), inArray(s.campaigns.status, [...listedStatuses, 'archived']), isNotNull(s.campaigns.opensAt), isNotNull(s.campaigns.closesAt)));
	if (!campaign) throw notFound('Campaña');
	return campaign;
}
