import { randomBytes } from 'node:crypto';
import {
	checkLegalVersion,
	isLegalBlockKey,
	legalVersionSetting,
	mapsLink,
	parseCmsBlock,
	productSlugSchema,
	socialLinksSchema,
	storedWhatsApp,
	themeOverridesSchema,
	type CmsBlockKey,
	type ThemeOverrides
} from '@sortea/domain';
import { maskSecret, sealSecret, sha256Hex, type KeyRing } from '@sortea/domain/server';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { DatabaseHandle, Tx } from './client';
import * as s from './schema';
import type { OrganizationSettings } from './schema';
import { buildSamplePdf } from './scripts/sample-pdf';

/**
 * A client pack is one organization's content as data: brand, theme, contact,
 * CMS blocks, catalog and a demo campaign. The seed loads the fictional ones
 * (packages/db/src/packs) and `pnpm client:load <client>` loads a real client's
 * pack from the private `clients/<client>/pack.ts`, which is never published.
 *
 * Loading is additive. A missing organization is created; an existing one with
 * the same slug is left as it is, or with `update` gets its name, settings,
 * theme and CMS blocks refreshed (blocks as new published versions, like the
 * site editor publishes them). The catalog, campaign, members and hosts of an
 * existing organization are never changed, no other organization is touched,
 * and approvals are always created `pending`: a pack cannot carry one
 * (AGENTS.md, ADR 0015).
 */

export type OrgRole = (typeof s.orgRoles)[number];
type PrizeRow = typeof s.prizes.$inferInsert;

export interface ProductSeed {
	slug: string;
	name: string;
	description: string;
	kind: 'digital' | 'physical';
	priceMinor: number;
	sku: string;
	stock?: number;
	/** A digital product gets a one-page sample PDF; the real file goes in with `pnpm db:product-file`. */
	asset?: boolean;
	imageUrl?: string;
	/** Several variants (sizes) sharing the product's price. */
	variants?: { sku: string; name: string; stock?: number }[];
}

export interface FaqSeed {
	question: string;
	answer: string;
}

export interface PrizeSeed {
	kind: PrizeRow['kind'];
	title: string;
	description?: string;
	conditions?: string;
	declaredValueMinor: number;
	quantity: number;
	alternatesCount: number;
	mechanism: NonNullable<PrizeRow['mechanism']>;
	imageUrl?: string;
}

export interface CampaignSeed {
	slug: string;
	title: string;
	subtitle: string;
	summary: string;
	timezone: string;
	/** ISO 8601 with offset. */
	opensAt: string;
	closesAt: string;
	drawAt: string;
	isDemo: boolean;
	seo: { title: string; description: string };
	/** Saved as version 1 of the rules, in draft. */
	rulesMarkdown: string;
	eligibility: { minAge: number; residency: string; excluded: string[] };
	/** Chances per unit of each product, the same for all its variants. */
	chancesPerUnit: Record<string, number>;
	prizes: PrizeSeed[];
	faqs: FaqSeed[];
}

export interface ClientPack {
	slug: string;
	name: string;
	orderPrefix: string;
	/**
	 * Hostnames in order of preference. Those another organization already uses
	 * are skipped; the first one bound is the primary host.
	 */
	hosts: string[];
	settings: OrganizationSettings;
	theme: ThemeOverrides;
	members: { email: string; role: OrgRole }[];
	blocks: { key: CmsBlockKey; content: Record<string, unknown> }[];
	products: ProductSeed[];
	/** Every product with a pitch is suggested in the cart of every other product. */
	pitches?: Record<string, string>;
	/** FAQs of the whole site, not of a campaign. */
	siteFaqs?: FaqSeed[];
	campaign?: CampaignSeed;
}

/** What the loader needs outside the database. */
export interface ClientPackServices {
	/** Finds or creates the back-office user with this email. */
	ensureUser(email: string): Promise<{ id: string; created: boolean }>;
	/** Puts a file in the private product-files bucket. */
	uploadProductFile(path: string, bytes: Uint8Array, contentType: string): Promise<void>;
	/**
	 * Connects the local payment simulator, sealed like a real account. Left out
	 * where real Mercado Pago accounts are connected from the platform console.
	 */
	paymentSimulator?: { ring: KeyRing; webhookSecret: string };
}

export interface ClientPackOptions {
	/** Refresh the content of an existing organization with the same slug. */
	update?: boolean;
	now?: () => Date;
}

export interface ClientPackResult {
	outcome: 'created' | 'exists' | 'updated';
	organizationId: string;
	primaryHost: string | null;
	/** Hosts of the organization; on creation, the ones bound now. */
	hosts: string[];
	/** Users created for the pack's members. */
	createdUsers: string[];
	/** What `update` changed: `name`, `settings`, `theme`, `block <key>`. */
	changes: string[];
}

export class ClientPackRefusedError extends Error {}

const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const hostPattern = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

/** Problems of a pack, one line each; empty when it can be loaded. */
export function validateClientPack(pack: ClientPack): string[] {
	const problems: string[] = [];
	const issues = (error: { issues: { path: PropertyKey[]; message: string }[] }) => error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
	if (!slugPattern.test(pack.slug)) problems.push('slug: use lowercase letters, digits and dashes');
	if (!pack.name?.trim()) problems.push('name: required');
	if (!/^[A-Z]{2,4}$/.test(pack.orderPrefix)) problems.push('orderPrefix: use 2 to 4 capital letters');
	if (pack.hosts.length === 0) problems.push('hosts: list at least one hostname');
	for (const host of pack.hosts) if (!hostPattern.test(host)) problems.push(`hosts: ${host} is not a hostname`);
	const theme = themeOverridesSchema.safeParse(pack.theme);
	if (!theme.success) problems.push(`theme: ${issues(theme.error)}`);
	const { contact, social } = pack.settings;
	if (contact.whatsapp && !storedWhatsApp(contact.whatsapp)) problems.push('settings.contact.whatsapp: not an international number');
	if (contact.mapsUrl && !mapsLink(contact.mapsUrl)) problems.push('settings.contact.mapsUrl: not a Google Maps link');
	const links = socialLinksSchema.safeParse(social);
	if (!links.success) problems.push(`settings.social: ${issues(links.error)}`);
	for (const block of pack.blocks) {
		const parsed = parseCmsBlock(block.key, block.content);
		if (!parsed.success) problems.push(`block ${block.key}: ${parsed.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ')}`);
		else if (isLegalBlockKey(block.key) && parsed.data.version !== pack.settings.legal[legalVersionSetting[block.key]]) {
			problems.push(`block ${block.key}: its version must match settings.legal.${legalVersionSetting[block.key]}`);
		}
	}
	const slugs = new Set<string>();
	for (const product of pack.products) {
		if (!productSlugSchema.safeParse(product.slug).success) problems.push(`products: slug ${product.slug} is not valid`);
		if (slugs.has(product.slug)) problems.push(`products: slug ${product.slug} is repeated`);
		slugs.add(product.slug);
		if (!Number.isInteger(product.priceMinor) || product.priceMinor < 0) problems.push(`products: ${product.slug} needs a price in whole minor units`);
	}
	for (const slug of Object.keys(pack.pitches ?? {})) if (!slugs.has(slug)) problems.push(`pitches: no product ${slug}`);
	if (pack.campaign) {
		if (!slugPattern.test(pack.campaign.slug)) problems.push('campaign.slug: use lowercase letters, digits and dashes');
		for (const [slug, perUnit] of Object.entries(pack.campaign.chancesPerUnit)) {
			if (!slugs.has(slug)) problems.push(`campaign.chancesPerUnit: no product ${slug}`);
			else if (!Number.isInteger(perUnit) || perUnit < 1) problems.push(`campaign.chancesPerUnit: ${slug} must be a whole number of at least 1`);
		}
		for (const field of ['opensAt', 'closesAt', 'drawAt'] as const) {
			if (Number.isNaN(Date.parse(pack.campaign[field]))) problems.push(`campaign.${field}: not a date`);
		}
		if (pack.campaign.prizes.length === 0) problems.push('campaign.prizes: list at least one prize');
	}
	return problems;
}

export async function loadClientPack(handle: DatabaseHandle, pack: ClientPack, services: ClientPackServices, options: ClientPackOptions = {}): Promise<ClientPackResult> {
	const problems = validateClientPack(pack);
	if (problems.length > 0) throw new ClientPackRefusedError(`Invalid client pack ${pack.slug}:\n  ${problems.join('\n  ')}`);
	const now = options.now ?? (() => new Date());
	// Creating an organization and reading which hosts are free is platform-level by nature (ADR 0001).
	return handle.withPlatform((db) =>
		db.transaction(async (tx) => {
			// One load at a time, so two loads never bind the same host or slug.
			await tx.execute(sql`select pg_advisory_xact_lock(hashtext('client-pack'))`);
			const [existing] = await tx.select({ id: s.organizations.id }).from(s.organizations).where(eq(s.organizations.slug, pack.slug));
			if (existing) {
				const domains = await tx
					.select({ hostname: s.organizationDomains.hostname, isPrimary: s.organizationDomains.isPrimary })
					.from(s.organizationDomains)
					.where(eq(s.organizationDomains.organizationId, existing.id))
					.orderBy(s.organizationDomains.createdAt, s.organizationDomains.hostname);
				const ordered = [...domains.filter((domain) => domain.isPrimary), ...domains.filter((domain) => !domain.isPrimary)];
				const hosts = ordered.map((domain) => domain.hostname);
				const base = { organizationId: existing.id, primaryHost: ordered.find((domain) => domain.isPrimary)?.hostname ?? null, hosts, createdUsers: [] };
				if (!options.update) return { outcome: 'exists', ...base, changes: [] };
				return { outcome: 'updated', ...base, changes: await updateContent(tx, existing.id, pack, now()) };
			}
			return createOrganization(tx, pack, services, now());
		})
	);
}

async function createOrganization(tx: Tx, pack: ClientPack, services: ClientPackServices, now: Date): Promise<ClientPackResult> {
	const taken = await tx
		.select({ hostname: s.organizationDomains.hostname })
		.from(s.organizationDomains)
		.where(inArray(s.organizationDomains.hostname, pack.hosts));
	const takenHosts = new Set(taken.map((row) => row.hostname));
	const hosts = pack.hosts.filter((host) => !takenHosts.has(host));
	if (hosts.length === 0) {
		throw new ClientPackRefusedError(`Every host of ${pack.slug} is already bound to another organization: ${pack.hosts.join(', ')}. Pass --host <hostname> with a free one.`);
	}

	const [org] = await tx
		.insert(s.organizations)
		.values({ slug: pack.slug, name: pack.name, orderPrefix: pack.orderPrefix, settings: pack.settings })
		.returning({ id: s.organizations.id });
	const organizationId = org!.id;
	await tx.insert(s.organizationDomains).values(hosts.map((hostname, index) => ({ organizationId, hostname, isPrimary: index === 0, verifiedAt: now })));
	await tx.insert(s.organizationThemes).values({ organizationId, tokens: pack.theme });

	const createdUsers: string[] = [];
	for (const member of pack.members) {
		const user = await services.ensureUser(member.email);
		if (user.created) createdUsers.push(member.email);
		await tx.insert(s.organizationMembers).values({ organizationId, userId: user.id, email: member.email, role: member.role });
	}
	if (services.paymentSimulator) await connectPaymentSimulator(tx, organizationId, services.paymentSimulator);

	if (pack.blocks.length > 0) {
		const rows = await tx
			.insert(s.cmsBlocks)
			.values(pack.blocks.map((block) => ({ organizationId, key: block.key, content: parsedBlock(block), publishedAt: now })))
			.returning();
		await tx.insert(s.cmsBlockRevisions).values(
			rows.map((row) => ({ organizationId, blockId: row.id, key: row.key, locale: row.locale, version: row.version, content: row.content!, publishedAt: row.publishedAt! }))
		);
	}

	const products = await createCatalog(tx, organizationId, pack.products, services);
	const pitches = pack.pitches ?? {};
	for (const anchor of pack.products.map((product) => product.slug)) {
		const suggested = Object.keys(pitches).filter((slug) => slug !== anchor);
		if (suggested.length === 0) continue;
		const [offer] = await tx
			.insert(s.offers)
			.values({ organizationId, kind: 'upsell', anchorProductId: products[anchor]!.productId, title: 'Sumá a tu pedido' })
			.returning({ id: s.offers.id });
		await tx
			.insert(s.offerItems)
			.values(suggested.map((slug, position) => ({ organizationId, offerId: offer!.id, variantId: products[slug]!.variantIds[0]!, position, pitch: pitches[slug]! })));
	}

	if (pack.siteFaqs?.length) {
		await tx.insert(s.campaignFaqs).values(pack.siteFaqs.map((faq, position) => ({ organizationId, campaignId: null, position, ...faq })));
	}
	if (pack.campaign) await createDemoCampaign(tx, organizationId, pack.campaign, products);

	await tx.insert(s.auditEvents).values({
		organizationId,
		actorType: 'system',
		action: 'organization.pack_loaded',
		targetType: 'organization',
		targetId: organizationId,
		metadata: { pack: pack.slug, hosts }
	});
	return { outcome: 'created', organizationId, primaryHost: hosts[0]!, hosts, createdUsers, changes: [] };
}

async function createCatalog(tx: Tx, organizationId: string, items: ProductSeed[], services: ClientPackServices) {
	const result: Record<string, { productId: string; variantIds: string[] }> = {};
	for (const [position, item] of items.entries()) {
		const [product] = await tx
			.insert(s.products)
			.values({ organizationId, slug: item.slug, name: item.name, description: item.description, kind: item.kind, status: 'active', position, imageUrl: item.imageUrl ?? null })
			.returning({ id: s.products.id });
		const variants = item.variants ?? [{ sku: item.sku, name: item.name, stock: item.stock }];
		const inserted = await tx
			.insert(s.productVariants)
			.values(variants.map((entry) => ({ organizationId, productId: product!.id, sku: entry.sku, name: entry.name, priceMinor: item.priceMinor, stock: entry.stock ?? null })))
			.returning({ id: s.productVariants.id });
		if (item.asset) {
			// The real files are pushed with `pnpm db:product-file` (README, "Product files").
			const pdf = buildSamplePdf([item.name, 'Archivo de muestra para desarrollo local.', 'Reemplazalo con pnpm db:product-file.']);
			const storagePath = `${organizationId}/${product!.id}/${item.slug}.pdf`;
			await services.uploadProductFile(storagePath, pdf, 'application/pdf');
			await tx.insert(s.productAssets).values({
				organizationId,
				productId: product!.id,
				storagePath,
				filename: `${item.slug}.pdf`,
				contentType: 'application/pdf',
				sizeBytes: pdf.byteLength
			});
		}
		result[item.slug] = { productId: product!.id, variantIds: inserted.map((entry) => entry.id) };
	}
	return result;
}

async function createDemoCampaign(tx: Tx, organizationId: string, campaign: CampaignSeed, products: Record<string, { variantIds: string[] }>): Promise<void> {
	const [row] = await tx
		.insert(s.campaigns)
		.values({
			organizationId,
			slug: campaign.slug,
			title: campaign.title,
			subtitle: campaign.subtitle,
			summary: campaign.summary,
			status: 'published',
			timezone: campaign.timezone,
			opensAt: new Date(campaign.opensAt),
			closesAt: new Date(campaign.closesAt),
			drawAt: new Date(campaign.drawAt),
			requiredApprovals: ['legal', 'psp'],
			isDemo: campaign.isDemo,
			seo: campaign.seo
		})
		.returning({ id: s.campaigns.id });
	const campaignId = row!.id;
	// Approvals are recorded by a person in the admin (ADR 0015); a pack never grants one.
	await tx.insert(s.campaignApprovals).values([
		{ organizationId, campaignId, kind: 'legal', status: 'pending' },
		{ organizationId, campaignId, kind: 'psp', status: 'pending' }
	]);
	const entriesPerUnit = Object.fromEntries(
		Object.entries(campaign.chancesPerUnit).flatMap(([slug, perUnit]) => products[slug]!.variantIds.map((variantId) => [variantId, perUnit]))
	);
	await tx.insert(s.campaignRuleVersions).values({
		organizationId,
		campaignId,
		version: 1,
		status: 'draft',
		bodyMarkdown: campaign.rulesMarkdown,
		eligibility: campaign.eligibility,
		entryRule: { mode: 'per_unit', entriesPerUnit, maxEntriesPerIdentity: null },
		contentHash: sha256Hex(campaign.rulesMarkdown)
	});
	await tx.insert(s.prizes).values(campaign.prizes.map((prize, index) => ({ organizationId, campaignId, position: index + 1, ...prize })));
	if (campaign.faqs.length > 0) {
		await tx.insert(s.campaignFaqs).values(campaign.faqs.map((faq, position) => ({ organizationId, campaignId, position, ...faq })));
	}
}

/**
 * Sandbox integration backed by the local payment simulator. The secrets are
 * sealed exactly like real ones, so the webhook path is identical.
 */
async function connectPaymentSimulator(tx: Tx, organizationId: string, simulator: NonNullable<ClientPackServices['paymentSimulator']>): Promise<void> {
	const accessToken = `TEST-fake-${randomBytes(12).toString('hex')}`;
	// Same formula as simulatorCollectorId() in apps/api/src/payments/simulator.ts.
	const collectorId = `sim-${sha256Hex(accessToken).slice(0, 10)}`;
	const [integration] = await tx
		.insert(s.organizationIntegrations)
		.values({
			organizationId,
			provider: 'mercadopago',
			mode: 'sandbox',
			publicConfig: { collectorId, publicKey: 'TEST-fake-public-key', simulator: 'true' },
			sealedSecrets: 'pending',
			keyVersion: simulator.ring.current,
			secretHint: maskSecret(accessToken)
		})
		.returning({ id: s.organizationIntegrations.id });
	const sealed = sealSecret(simulator.ring, JSON.stringify({ accessToken, webhookSecret: simulator.webhookSecret }), `${organizationId}:${integration!.id}`);
	await tx.update(s.organizationIntegrations).set({ sealedSecrets: sealed }).where(eq(s.organizationIntegrations.id, integration!.id));
}

/**
 * Refreshes what the pack says about an existing organization, publishing
 * each changed block the way the site editor does (apps/api/src/modules/cms.ts):
 * a new version, its revision, and for legal texts a new version that buyers
 * have not accepted yet. Unsaved editor drafts are kept.
 */
async function updateContent(tx: Tx, organizationId: string, pack: ClientPack, now: Date): Promise<string[]> {
	const changes: string[] = [];
	const [org] = await tx.select().from(s.organizations).where(eq(s.organizations.id, organizationId)).for('update');
	const legal = { ...org!.settings.legal };

	const blocks = await tx.select().from(s.cmsBlocks).where(and(eq(s.cmsBlocks.organizationId, organizationId), eq(s.cmsBlocks.locale, 'es-AR')));
	const publish: { key: CmsBlockKey; content: Record<string, unknown>; current: (typeof blocks)[number] | undefined }[] = [];
	for (const block of pack.blocks) {
		const content = parsedBlock(block);
		const current = blocks.find((row) => row.key === block.key);
		const published = current?.publishedAt && current.content ? parseCmsBlock(block.key, current.content) : null;
		if (published?.success && stableJson(published.data) === stableJson(content)) continue;
		if (isLegalBlockKey(block.key)) {
			const setting = legalVersionSetting[block.key];
			const version = String(content.version);
			const otherText = current
				? await tx
						.select({ id: s.cmsBlockRevisions.id })
						.from(s.cmsBlockRevisions)
						.where(
							and(
								eq(s.cmsBlockRevisions.blockId, current.id),
								sql`${s.cmsBlockRevisions.content}->>'version' = ${version}`,
								sql`${s.cmsBlockRevisions.content} <> ${JSON.stringify(content)}::jsonb`
							)
						)
						.limit(1)
				: [];
			const check = checkLegalVersion(org!.settings.legal[setting], version, { usedForOtherText: otherText.length > 0 });
			if (!check.ok) {
				const reason = {
					version_unchanged: `publish the new text with a new version; buyers already accepted version ${version}.`,
					version_used: `version ${version} was already published with another text; use a new version.`,
					version_reserved: `version ${version} is reserved.`
				}[check.reason];
				throw new ClientPackRefusedError(`${block.key}: ${reason}`);
			}
			legal[setting] = version;
		}
		publish.push({ key: block.key, content, current });
	}

	if (org!.name !== pack.name) {
		changes.push('name');
	}
	// The legal versions in force are those of the published texts, never ahead of them.
	const settings: OrganizationSettings = { ...pack.settings, legal: { ...pack.settings.legal, termsVersion: legal.termsVersion, privacyVersion: legal.privacyVersion } };
	if (stableJson(settings) !== stableJson(org!.settings)) changes.push('settings');
	if (changes.length > 0) {
		await tx.update(s.organizations).set({ name: pack.name, settings, updatedAt: now }).where(eq(s.organizations.id, organizationId));
	}

	// Same as the platform console's theme change (apps/api/src/modules/platform.ts).
	const [theme] = await tx
		.select()
		.from(s.organizationThemes)
		.where(and(eq(s.organizationThemes.organizationId, organizationId), eq(s.organizationThemes.isActive, true), sql`${s.organizationThemes.campaignId} is null`));
	if (!theme || stableJson(theme.tokens) !== stableJson(pack.theme)) {
		await tx.update(s.organizationThemes).set({ isActive: false }).where(and(eq(s.organizationThemes.organizationId, organizationId), sql`${s.organizationThemes.campaignId} is null`));
		await tx.insert(s.organizationThemes).values({ organizationId, tokens: pack.theme, version: (theme?.version ?? 0) + 1 });
		changes.push('theme');
	}

	for (const { key, content, current } of publish) {
		let blockId: string;
		let version: number;
		if (current) {
			version = current.publishedAt ? current.version + 1 : current.version;
			await tx.update(s.cmsBlocks).set({ content, version, publishedAt: now, publishedBy: null, updatedAt: now }).where(eq(s.cmsBlocks.id, current.id));
			blockId = current.id;
		} else {
			const [row] = await tx.insert(s.cmsBlocks).values({ organizationId, key, content, publishedAt: now }).returning();
			blockId = row!.id;
			version = row!.version;
		}
		await tx.insert(s.cmsBlockRevisions).values({ organizationId, blockId, key, locale: 'es-AR', version, content, publishedAt: now });
		changes.push(`block ${key}`);
	}

	if (changes.length > 0) {
		await tx.insert(s.auditEvents).values({
			organizationId,
			actorType: 'system',
			action: 'organization.pack_updated',
			targetType: 'organization',
			targetId: organizationId,
			metadata: { pack: pack.slug, changes }
		});
	}
	return changes;
}

/** The block as the site renders it: validated, with its defaults filled in. */
function parsedBlock(block: ClientPack['blocks'][number]): Record<string, unknown> {
	const parsed = parseCmsBlock(block.key, block.content);
	if (!parsed.success) throw new ClientPackRefusedError(`block ${block.key} is invalid`);
	return parsed.data;
}

/** JSON with sorted keys, so content read back from jsonb compares equal to the pack's. */
function stableJson(value: unknown): string {
	return JSON.stringify(value, (_key, entry: unknown) =>
		entry && typeof entry === 'object' && !Array.isArray(entry) ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b))) : entry
	);
}
