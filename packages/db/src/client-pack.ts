import { randomBytes } from 'node:crypto';
import {
	checkLegalVersion,
	hasProductFileExtension,
	isLegalBlockKey,
	legalVersionSetting,
	mapsLink,
	parseCmsBlock,
	PRODUCT_FILES_MAX,
	productFileKindOf,
	productSlugSchema,
	socialLinksSchema,
	storedWhatsApp,
	themeOverridesSchema,
	type CmsBlockKey,
	type ProductFileContentType,
	type ThemeOverrides
} from '@sortea/domain';
import { maskSecret, sealSecret, sha256Hex, type KeyRing } from '@sortea/domain/server';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { createCampaign } from './campaigns';
import type { DatabaseHandle, Tx } from './client';
import { productFilePath, replaceProductFile, safeFilename, syncProductFiles, type ProductFileOptions, type ProductFilesResult, type ProductFileStorage } from './product-file';
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
 * site editor publishes them). With `catalog` too, its products are created or
 * updated by slug, never deleted. The campaign, members and hosts of an
 * existing organization are never changed, no other organization is touched,
 * and approvals are always created `pending`: a pack cannot carry one
 * (AGENTS.md, ADR 0015).
 *
 * A digital product delivers the real files the pack declares in `files`, one
 * download link each; their bytes come from `readDeclaredFile` and must match
 * the declared sha256. A
 * local database may get a one-page sample PDF instead; a deployed one never
 * does (`realFilesOnly`).
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
	/**
	 * A digital product that delivers a file: the one the pack declares in `files`,
	 * or, on a local database without it, a one-page sample PDF.
	 */
	asset?: boolean;
	imageUrl?: string;
	/**
	 * `draft` creates the product out of the shop, for one the client still has to finish (its
	 * final file or photo); `active` by default. Only a new product takes it: an existing one keeps
	 * the status the shop gave it.
	 */
	status?: 'draft' | 'active';
	/** Several variants (sizes) sharing the product's price. */
	variants?: { sku: string; name: string; stock?: number }[];
}

/**
 * A digital product's real file, as `pnpm client:export` found it. The bytes are
 * kept outside git, in `clients/<client>/files/<sha256 prefix>-<filename>`
 * (README, "Client packs").
 */
export interface ProductFileSeed {
	/** Name the buyer's download gets. */
	filename: string;
	sha256: string;
	contentType: ProductFileContentType;
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
	/**
	 * The real files of each digital product, by product slug: one file, or a list in the order
	 * buyers get them, each with its own download link (owner-feedback-2026-11-11b, S2).
	 */
	files?: Record<string, ProductFileSeed | ProductFileSeed[]>;
	/** Every product with a pitch is suggested in the cart of every other product. */
	pitches?: Record<string, string>;
	/** FAQs of the whole site, not of a campaign. */
	siteFaqs?: FaqSeed[];
	campaign?: CampaignSeed;
}

/** What the loader needs outside the database. */
export interface ClientPackServices {
	/** Finds or creates the back-office user with this email, inside the loader's transaction (packages/db/src/admin-users.ts). */
	ensureUser(email: string, tx: Tx): Promise<{ id: string; created: boolean }>;
	/** Puts a file in the private product-files bucket. */
	uploadProductFile(path: string, bytes: Uint8Array, contentType: string): Promise<void>;
	/**
	 * The bytes of a file the pack declares, and where they were found, or null
	 * when there is no copy (packages/db/src/client-files.ts). The loader checks
	 * their sha256.
	 */
	readDeclaredFile?(productSlug: string, file: ProductFileSeed): Promise<DeclaredFileBytes | null>;
	/** The product-files bucket, for a `catalog` update that replaces a product's file like `pnpm db:product-file`. */
	productFileStorage?: ProductFileStorage;
	/**
	 * Connects the local payment simulator, sealed like a real account. Left out
	 * where real Mercado Pago accounts are connected from the platform console.
	 */
	paymentSimulator?: { ring: KeyRing; webhookSecret: string };
}

export interface DeclaredFileBytes {
	bytes: Uint8Array;
	/** `local`: the pack's files directory; `incoming`: uploaded to the bucket by `pnpm client:upload-files`. */
	source: 'local' | 'incoming';
	location: string;
}

export interface ClientPackOptions {
	/** Refresh the content of an existing organization with the same slug. */
	update?: boolean;
	/** With `update`, also create missing products and update existing ones by slug, files included. */
	catalog?: boolean;
	/**
	 * With `update`, also add the pack's campaign, as a draft, when the organization has no
	 * campaign with its slug. An existing campaign is never changed: it is edited in the admin.
	 */
	campaign?: boolean;
	/** A deployed database: every digital product gets its declared real file, never the sample PDF. */
	realFilesOnly?: boolean;
	/** For the files a `catalog` update replaces; tests pass a `sleep` that does not wait. */
	productFileOptions?: ProductFileOptions;
	now?: () => Date;
}

/** What happened to a file the pack declares. */
export interface PlacedFile {
	productSlug: string;
	filename: string;
	/** `sample`: the declared file was missing on a local database, so the product got the sample PDF. */
	source: DeclaredFileBytes['source'] | 'sample';
	location?: string;
}

export interface ClientPackResult {
	outcome: 'created' | 'exists' | 'updated';
	organizationId: string;
	primaryHost: string | null;
	/** Hosts of the organization; on creation, the ones bound now. */
	hosts: string[];
	/** Users created for the pack's members. */
	createdUsers: string[];
	/** What `update` changed: `name`, `settings`, `theme`, `block <key>`, and with `catalog` `product <slug>`, `product <slug> added`, `file <slug> <outcome>`. */
	changes: string[];
	/** The declared files placed by this load, when there are any. */
	files?: PlacedFile[];
}

export class ClientPackRefusedError extends Error {}

/** The files the pack declares for a product, in order; empty when it declares none. */
export function declaredFiles(pack: Pick<ClientPack, 'files'>, productSlug: string): ProductFileSeed[] {
	const declared = pack.files?.[productSlug];
	return declared === undefined ? [] : Array.isArray(declared) ? declared : [declared];
}

/** Every file the pack declares, product by product. */
export function everyDeclaredFile(pack: Pick<ClientPack, 'files'>): { productSlug: string; file: ProductFileSeed }[] {
	return Object.keys(pack.files ?? {}).flatMap((productSlug) => declaredFiles(pack, productSlug).map((file) => ({ productSlug, file })));
}

/** The refusal for bytes that are not the file the pack declares. */
export function checksumRefusal(productSlug: string, location: string, actual: string, expected: string): ClientPackRefusedError {
	return new ClientPackRefusedError(`${productSlug}: ${location} has sha256 ${actual}, not the ${expected} the pack declares. Export the pack again or put the right file in place.`);
}

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
	for (const [slug, declared] of Object.entries(pack.files ?? {})) {
		const product = pack.products.find((entry) => entry.slug === slug);
		if (!product) problems.push(`files.${slug}: no product ${slug}`);
		else if (product.kind !== 'digital') problems.push(`files.${slug}: ${slug} is a physical product; only digital products deliver files`);
		const list = Array.isArray(declared) ? declared : [declared];
		if (Array.isArray(declared) && list.length === 0) problems.push(`files.${slug}: list at least one file`);
		if (list.length > PRODUCT_FILES_MAX) problems.push(`files.${slug}: ${list.length} files; a product delivers at most ${PRODUCT_FILES_MAX}`);
		for (const [index, file] of list.entries()) {
			const at = (other: number) => (Array.isArray(declared) ? `files.${slug}[${other}]` : `files.${slug}`);
			const where = at(index);
			const sameFile = list.findIndex((other) => other.sha256 === file.sha256);
			if (sameFile < index) problems.push(`${where}: the same file as ${at(sameFile)}`);
			const sameName = list.findIndex((other) => other.filename === file.filename);
			if (sameName < index && sameFile === index) problems.push(`${where}: ${file.filename} is the download name of ${at(sameName)} too`);
			if (!/^[0-9a-f]{64}$/.test(file.sha256)) problems.push(`${where}: sha256 must be 64 lowercase hexadecimal characters`);
			if (!safeFilename.test(file.filename)) problems.push(`${where}: ${file.filename} may only use letters A-Z, digits, dots, dashes and underscores`);
			const kind = productFileKindOf(file.contentType);
			if (!kind) problems.push(`${where}: ${file.contentType} is not a PDF, ZIP, PNG or JPEG content type`);
			else if (!hasProductFileExtension(file.filename, kind)) problems.push(`${where}: a ${file.contentType} file must end in .${kind.extension}`);
		}
	}
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
	if (options.update && options.catalog && everyDeclaredFile(pack).length > 0 && !services.productFileStorage) {
		throw new Error('A catalog update of a pack with files needs services.productFileStorage');
	}
	const now = options.now ?? (() => new Date());
	const files: FileContext = { pack, services, options, placed: [], replacements: [] };
	// Creating an organization and reading which hosts are free is platform-level by nature (ADR 0001).
	const result: ClientPackResult = await handle.withPlatform((db) =>
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
				return { outcome: 'updated', ...base, changes: await updateContent(tx, existing.id, pack, now(), files) };
			}
			return createOrganization(tx, pack, services, now(), files);
		})
	);
	// After the catalog commits: the same replacement as `pnpm db:product-file`, which keeps the asset row so links
	// already sent deliver the new file, and deletes the previous object once its signed URLs expire. A list of
	// files is synced the same way: each new file takes the row of one the list left out, in order.
	for (const replacement of files.replacements) {
		const { productSlug } = replacement;
		if (replacement.list) {
			const synced = await syncProductFiles(
				handle,
				services.productFileStorage!,
				{ organizationSlug: pack.slug, productSlug, files: replacement.files.map(({ filename, bytes }) => ({ filename, bytes })) },
				options.productFileOptions
			);
			result.changes.push(`files ${productSlug}: ${syncSummary(synced)}`);
		} else {
			const file = replacement.files[0]!;
			const replaced = await replaceProductFile(handle, services.productFileStorage!, { organizationSlug: pack.slug, productSlug, filename: file.filename, bytes: file.bytes }, options.productFileOptions);
			result.changes.push(`file ${productSlug} ${replaced.outcome}`);
		}
		for (const file of replacement.files) files.placed.push({ productSlug, filename: file.filename, source: file.source, location: file.location });
	}
	return files.placed.length > 0 ? { ...result, files: files.placed } : result;
}

/** The pack's files during one load: what was placed, and what a catalog update replaces after it commits. */
interface FileContext {
	pack: ClientPack;
	services: ClientPackServices;
	options: ClientPackOptions;
	placed: PlacedFile[];
	/** `list`: the pack declares a list (synced), else one file (replaced like `pnpm db:product-file`). */
	replacements: { productSlug: string; list: boolean; files: ({ filename: string } & DeclaredFileBytes)[] }[];
}

/** What a list sync changed, e.g. `1 replaced, 2 added`. */
function syncSummary(result: ProductFilesResult): string {
	const outcomes = ['replaced', 'added', 'restored', 'moved', 'removed'] as const;
	const parts = outcomes
		.map((outcome) => [outcome, result.changes.filter((change) => change.outcome === outcome).length] as const)
		.filter(([, total]) => total > 0)
		.map(([outcome, total]) => `${total} ${outcome}`);
	return parts.length > 0 ? parts.join(', ') : 'unchanged';
}

/** The declared file's bytes, checked against its sha256, or null when there is no copy. */
async function declaredBytes(files: FileContext, productSlug: string, file: ProductFileSeed): Promise<DeclaredFileBytes | null> {
	const found = (await files.services.readDeclaredFile?.(productSlug, file)) ?? null;
	if (!found) return null;
	const actual = sha256Hex(found.bytes);
	if (actual !== file.sha256) throw checksumRefusal(productSlug, found.location, actual, file.sha256);
	return found;
}

function missingFile(pack: ClientPack, productSlug: string, file: ProductFileSeed): ClientPackRefusedError {
	return new ClientPackRefusedError(
		`${productSlug}: its file ${file.filename} is not on this machine nor uploaded to the bucket; run pnpm client:upload-files ${pack.slug} first. A deployed database never gets a sample file.`
	);
}

async function createOrganization(tx: Tx, pack: ClientPack, services: ClientPackServices, now: Date, files: FileContext): Promise<ClientPackResult> {
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
		const user = await services.ensureUser(member.email, tx);
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

	const products: Record<string, { productId: string; variantIds: string[] }> = {};
	for (const [position, item] of pack.products.entries()) products[item.slug] = await createProduct(tx, organizationId, item, position, files);
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

/** The variants of a product as the pack describes them: its own, or one named like the product. */
function variantsOf(item: ProductSeed): { sku: string; name: string; stock?: number }[] {
	return item.variants ?? [{ sku: item.sku, name: item.name, stock: item.stock }];
}

async function createProduct(tx: Tx, organizationId: string, item: ProductSeed, position: number, files: FileContext) {
	const [product] = await tx
		.insert(s.products)
		.values({ organizationId, slug: item.slug, name: item.name, description: item.description, kind: item.kind, status: item.status ?? 'active', position, imageUrl: item.imageUrl ?? null })
		.returning({ id: s.products.id });
	const inserted = await tx
		.insert(s.productVariants)
		.values(variantsOf(item).map((entry) => ({ organizationId, productId: product!.id, sku: entry.sku, name: entry.name, priceMinor: item.priceMinor, stock: entry.stock ?? null })))
		.returning({ id: s.productVariants.id });
	const declared = declaredFiles(files.pack, item.slug);
	if (declared.length > 0 || item.asset) await placeFiles(tx, organizationId, product!.id, item, declared, files);
	return { productId: product!.id, variantIds: inserted.map((entry) => entry.id) };
}

/**
 * The new product's files: the declared ones in order, named by their hash like `pnpm db:product-file`, or on a
 * local database the sample PDF when one is missing.
 */
async function placeFiles(tx: Tx, organizationId: string, productId: string, item: ProductSeed, declared: ProductFileSeed[], files: FileContext): Promise<void> {
	const { pack, services, options } = files;
	if (declared.length > 0) {
		const found: DeclaredFileBytes[] = [];
		for (const file of declared) {
			const bytes = await declaredBytes(files, item.slug, file);
			if (bytes) found.push(bytes);
			else if (options.realFilesOnly) throw missingFile(pack, item.slug, file);
		}
		if (found.length === declared.length) {
			for (const [position, file] of declared.entries()) {
				const bytes = found[position]!;
				const storagePath = productFilePath(organizationId, productId, file.sha256, productFileKindOf(file.contentType)!);
				await services.uploadProductFile(storagePath, bytes.bytes, file.contentType);
				await tx
					.insert(s.productAssets)
					.values({ organizationId, productId, storagePath, filename: file.filename, contentType: file.contentType, sizeBytes: bytes.bytes.byteLength, position });
				files.placed.push({ productSlug: item.slug, filename: file.filename, source: bytes.source, location: bytes.location });
			}
			return;
		}
	} else if (options.realFilesOnly) {
		throw new ClientPackRefusedError(
			`${item.slug}: a deployed database needs the product's real file; declare it in the pack's files (pnpm client:export ${pack.slug}). A deployed database never gets a sample file.`
		);
	}
	// Local development only; the real file goes in with `pnpm client:export` or `pnpm db:product-file` (README, "Product files").
	const pdf = buildSamplePdf([item.name, 'Archivo de muestra para desarrollo local.', 'Reemplazalo con pnpm db:product-file.']);
	const storagePath = `${organizationId}/${productId}/${item.slug}.pdf`;
	await services.uploadProductFile(storagePath, pdf, 'application/pdf');
	await tx.insert(s.productAssets).values({ organizationId, productId, storagePath, filename: `${item.slug}.pdf`, contentType: 'application/pdf', sizeBytes: pdf.byteLength });
	if (declared.length > 0) files.placed.push({ productSlug: item.slug, filename: `${item.slug}.pdf`, source: 'sample' });
}

/**
 * The pack's catalog over an existing organization's, by product slug: missing
 * products are created; existing ones get the pack's name, description, image,
 * position, price (for all their variants) and variant names, and missing
 * variants. Nothing is deleted; the status and the stock of existing products are
 * the shop's own (the stock changes with every sale); suggestions, campaigns and
 * orders are not touched. A declared file that differs from the product's current one is
 * replaced after the transaction (loadClientPack).
 */
async function updateCatalog(tx: Tx, organizationId: string, now: Date, files: FileContext): Promise<string[]> {
	const { pack, options } = files;
	const changes: string[] = [];
	const rows = await tx.select().from(s.products).where(eq(s.products.organizationId, organizationId)).for('update');
	for (const [position, item] of pack.products.entries()) {
		const product = rows.find((row) => row.slug === item.slug);
		if (!product) {
			await createProduct(tx, organizationId, item, position, files);
			changes.push(`product ${item.slug} added`);
			continue;
		}
		if (product.kind !== item.kind) {
			throw new ClientPackRefusedError(`products.${item.slug}: it is a ${product.kind} product; a product never changes kind (create another product instead).`);
		}
		let changed = false;
		const fields = { name: item.name, description: item.description, imageUrl: item.imageUrl ?? null, position };
		if (product.name !== fields.name || product.description !== fields.description || product.imageUrl !== fields.imageUrl || product.position !== fields.position) {
			await tx.update(s.products).set({ ...fields, updatedAt: now }).where(eq(s.products.id, product.id));
			changed = true;
		}
		const variants = await tx.select().from(s.productVariants).where(eq(s.productVariants.productId, product.id));
		for (const entry of variantsOf(item)) {
			const current = variants.find((variant) => variant.sku === entry.sku);
			if (!current) {
				await tx
					.insert(s.productVariants)
					.values({ organizationId, productId: product.id, sku: entry.sku, name: entry.name, priceMinor: item.priceMinor, stock: entry.stock ?? null });
				changed = true;
			} else if (current.name !== entry.name) {
				await tx.update(s.productVariants).set({ name: entry.name }).where(eq(s.productVariants.id, current.id));
				changed = true;
			}
		}
		if (variants.some((variant) => variant.priceMinor !== item.priceMinor)) {
			await tx.update(s.productVariants).set({ priceMinor: item.priceMinor }).where(eq(s.productVariants.productId, product.id));
			changed = true;
		}
		if (changed) changes.push(`product ${item.slug}`);

		const declared = declaredFiles(pack, item.slug);
		if (declared.length === 0) continue;
		const assets = await tx
			.select()
			.from(s.productAssets)
			.where(eq(s.productAssets.productId, product.id))
			.orderBy(asc(s.productAssets.position), asc(s.productAssets.createdAt));
		const current =
			assets.length === declared.length &&
			declared.every((file, index) => assets[index]!.filename === file.filename && assets[index]!.storagePath === productFilePath(organizationId, product.id, file.sha256, productFileKindOf(file.contentType)!));
		if (current) continue;
		const found: ({ filename: string } & DeclaredFileBytes)[] = [];
		for (const file of declared) {
			const bytes = await declaredBytes(files, item.slug, file);
			if (bytes) found.push({ filename: file.filename, ...bytes });
			else if (options.realFilesOnly) throw missingFile(pack, item.slug, file);
		}
		if (found.length === declared.length) files.replacements.push({ productSlug: item.slug, list: Array.isArray(pack.files![item.slug]), files: found });
		// Otherwise, on a local database, the product keeps the files it has.
	}
	return changes;
}

/**
 * The pack's campaign on an existing organization (`--update --campaign`): created as a draft
 * with the same function as the admin, so a person reviews it, records the approvals and opens
 * it there. Nothing happens when the organization already has a campaign with that slug.
 */
async function addCampaign(tx: Tx, organizationId: string, campaign: CampaignSeed): Promise<string[]> {
	const [existing] = await tx
		.select({ id: s.campaigns.id })
		.from(s.campaigns)
		.where(and(eq(s.campaigns.organizationId, organizationId), eq(s.campaigns.slug, campaign.slug)));
	if (existing) return [];
	const slugs = Object.keys(campaign.chancesPerUnit);
	const rows = slugs.length
		? await tx
				.select({ slug: s.products.slug, variantId: s.productVariants.id })
				.from(s.products)
				.innerJoin(s.productVariants, eq(s.productVariants.productId, s.products.id))
				.where(and(eq(s.products.organizationId, organizationId), inArray(s.products.slug, slugs)))
		: [];
	const entriesPerUnit: Record<string, number> = {};
	for (const [slug, perUnit] of Object.entries(campaign.chancesPerUnit)) {
		const variants = rows.filter((row) => row.slug === slug);
		if (variants.length === 0) {
			throw new ClientPackRefusedError(`campaign.chancesPerUnit: ${slug} is not a product of this organization yet; load the catalog first (--catalog).`);
		}
		for (const variant of variants) entriesPerUnit[variant.variantId] = perUnit;
	}
	// Approvals are created pending and recorded by a person in the admin (ADR 0015); a pack never grants one.
	await createCampaign(tx, organizationId, {
		slug: campaign.slug,
		title: campaign.title,
		subtitle: campaign.subtitle,
		summary: campaign.summary,
		status: 'draft',
		timezone: campaign.timezone,
		opensAt: new Date(campaign.opensAt),
		closesAt: new Date(campaign.closesAt),
		drawAt: new Date(campaign.drawAt),
		isDemo: campaign.isDemo,
		seo: campaign.seo,
		rulesMarkdown: campaign.rulesMarkdown,
		eligibility: campaign.eligibility,
		entriesPerUnit,
		requiredApprovals: ['legal', 'psp'],
		prizes: campaign.prizes,
		faqs: campaign.faqs
	});
	return [`campaign ${campaign.slug} added`];
}

/** The pack's demo campaign, built like one created in the admin (campaigns.ts) but already published with its dates. */
async function createDemoCampaign(tx: Tx, organizationId: string, campaign: CampaignSeed, products: Record<string, { variantIds: string[] }>): Promise<void> {
	const entriesPerUnit = Object.fromEntries(
		Object.entries(campaign.chancesPerUnit).flatMap(([slug, perUnit]) => products[slug]!.variantIds.map((variantId) => [variantId, perUnit]))
	);
	// Approvals are created pending and recorded by a person in the admin (ADR 0015); a pack never grants one.
	await createCampaign(tx, organizationId, {
		slug: campaign.slug,
		title: campaign.title,
		subtitle: campaign.subtitle,
		summary: campaign.summary,
		status: 'published',
		timezone: campaign.timezone,
		opensAt: new Date(campaign.opensAt),
		closesAt: new Date(campaign.closesAt),
		drawAt: new Date(campaign.drawAt),
		isDemo: campaign.isDemo,
		seo: campaign.seo,
		rulesMarkdown: campaign.rulesMarkdown,
		eligibility: campaign.eligibility,
		entriesPerUnit,
		requiredApprovals: ['legal', 'psp'],
		prizes: campaign.prizes,
		faqs: campaign.faqs
	});
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
async function updateContent(tx: Tx, organizationId: string, pack: ClientPack, now: Date, files: FileContext): Promise<string[]> {
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
	if (files.options.catalog) changes.push(...(await updateCatalog(tx, organizationId, now, files)));
	if (files.options.campaign && pack.campaign) changes.push(...(await addCampaign(tx, organizationId, pack.campaign)));

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
