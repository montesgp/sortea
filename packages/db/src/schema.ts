import {
	approvalKinds,
	campaignStatuses,
	discrepancyKinds,
	discrepancySeverities,
	documentTypes,
	orderStatuses,
	paymentStatuses,
	prizeMechanisms,
	type EntryAllocationRule,
	type OpsEventKind,
	type ThemeOverrides
} from '@sortea/domain';
import { sql } from 'drizzle-orm';
import {
	bigint,
	boolean,
	check,
	index,
	integer,
	jsonb,
	pgSchema,
	primaryKey,
	smallint,
	text,
	timestamp,
	uniqueIndex,
	uuid
} from 'drizzle-orm/pg-core';

/**
 * Everything lives in the `app` schema, which Supabase's REST API does not
 * expose. Every business table carries `organization_id`; row level security
 * (see migrations/*_tenant_rls.sql) restricts the `sortea_app` role to the
 * organization set for the current transaction.
 */
export const app = pgSchema('app');

const id = () => uuid('id').primaryKey().defaultRandom();
const organizationId = () =>
	uuid('organization_id')
		.notNull()
		.references(() => organizations.id, { onDelete: 'restrict' });
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();
const ts = (name: string) => timestamp(name, { withTimezone: true });

export const orgRoles = [
	'org_owner',
	'org_admin',
	'finance_manager',
	'campaign_operator',
	'auditor',
	'support_agent'
] as const;

export const organizationStatus = app.enum('organization_status', ['active', 'suspended']);
export const orgRole = app.enum('org_role', orgRoles);
export const memberStatus = app.enum('member_status', ['invited', 'active', 'disabled']);
export const integrationProvider = app.enum('integration_provider', ['mercadopago', 'resend']);
export const integrationMode = app.enum('integration_mode', ['sandbox', 'production']);
export const integrationStatus = app.enum('integration_status', ['configured', 'verified', 'error']);
export const campaignStatus = app.enum('campaign_status', campaignStatuses);
export const approvalKind = app.enum('approval_kind', approvalKinds);
export const approvalStatus = app.enum('approval_status', ['pending', 'approved', 'rejected']);
export const ruleVersionStatus = app.enum('rule_version_status', ['draft', 'locked', 'superseded']);
export const mediaKind = app.enum('media_kind', ['image', 'video', 'youtube']);
export const prizeKind = app.enum('prize_kind', ['vehicle', 'cash', 'product', 'digital']);
export const prizeMechanism = app.enum('prize_mechanism', prizeMechanisms);
export const awardRole = app.enum('award_role', ['winner', 'alternate']);
export const awardStatus = app.enum('award_status', ['pending_verification', 'accepted', 'declined', 'substituted', 'void']);
export const fulfillmentStatus = app.enum('fulfillment_status', ['pending', 'scheduled', 'delivered', 'failed']);
export const productKind = app.enum('product_kind', ['digital', 'physical']);
export const productStatus = app.enum('product_status', ['draft', 'active', 'archived']);
export const offerKind = app.enum('offer_kind', ['upsell', 'bundle']);
export const documentType = app.enum('document_type', documentTypes);
export const consentPurpose = app.enum('consent_purpose', ['terms', 'privacy', 'marketing_email']);
export const orderStatus = app.enum('order_status', orderStatuses);
export const deliveryMethod = app.enum('delivery_method', ['digital', 'pickup', 'shipping']);
export const paymentStatus = app.enum('payment_status', paymentStatuses);
export const entryStatus = app.enum('entry_status', ['eligible', 'void']);
export const ledgerEvent = app.enum('ledger_event', ['allocated', 'voided']);
export const outboxStatus = app.enum('outbox_status', ['pending', 'processing', 'done', 'dead']);
export const notificationStatus = app.enum('notification_status', ['queued', 'sent', 'failed']);
export const reconciliationRunKind = app.enum('reconciliation_run_kind', ['operations', 'settlements']);
export const reconciliationRunTrigger = app.enum('reconciliation_run_trigger', ['scheduled', 'manual', 'upload']);
export const reconciliationRunStatus = app.enum('reconciliation_run_status', ['running', 'completed', 'failed']);
export const discrepancyKind = app.enum('discrepancy_kind', discrepancyKinds);
export const discrepancySeverity = app.enum('discrepancy_severity', discrepancySeverities);
export const reconciliationItemStatus = app.enum('reconciliation_item_status', ['open', 'resolved']);
export const reconciliationResolution = app.enum('reconciliation_resolution', ['provider_state_applied', 'cleared', 'accepted']);

// ─── Tenancy and access ────────────────────────────────────────────────────

export interface OrganizationSettings {
	contact: { email?: string; phone?: string; whatsapp?: string; address?: string; city?: string };
	social: { instagram?: string; youtube?: string; tiktok?: string; facebook?: string };
	delivery: { pickupEnabled: boolean; shippingEnabled: boolean; shippingFeeMinor: number; pickupNote?: string };
	legal: { termsVersion: string; privacyVersion: string; businessName?: string; taxId?: string };
}

export const organizations = app.table('organizations', {
	id: id(),
	slug: text('slug').notNull().unique(),
	name: text('name').notNull(),
	status: organizationStatus('status').notNull().default('active'),
	locale: text('locale').notNull().default('es-AR'),
	timezone: text('timezone').notNull().default('America/Argentina/Buenos_Aires'),
	currency: text('currency').notNull().default('ARS'),
	orderPrefix: text('order_prefix').notNull(),
	modules: text('modules').array().notNull().default(sql`'{cms,commerce,campaigns}'::text[]`),
	settings: jsonb('settings').$type<OrganizationSettings>().notNull(),
	createdAt: createdAt(),
	updatedAt: updatedAt()
});

export const organizationDomains = app.table('organization_domains', {
	id: id(),
	organizationId: organizationId(),
	hostname: text('hostname').notNull().unique(),
	isPrimary: boolean('is_primary').notNull().default(false),
	verifiedAt: ts('verified_at'),
	createdAt: createdAt()
});

export const organizationThemes = app.table(
	'organization_themes',
	{
		id: id(),
		organizationId: organizationId(),
		campaignId: uuid('campaign_id'),
		version: integer('version').notNull().default(1),
		tokens: jsonb('tokens').$type<ThemeOverrides>().notNull(),
		isActive: boolean('is_active').notNull().default(true),
		createdAt: createdAt()
	},
	(t) => [
		uniqueIndex('organization_themes_active_uq')
			.on(t.organizationId, sql`coalesce(${t.campaignId}, '00000000-0000-0000-0000-000000000000'::uuid)`)
			.where(sql`${t.isActive}`)
	]
);

export const organizationIntegrations = app.table(
	'organization_integrations',
	{
		id: id(),
		organizationId: organizationId(),
		provider: integrationProvider('provider').notNull(),
		mode: integrationMode('mode').notNull(),
		status: integrationStatus('status').notNull().default('configured'),
		/** Non-secret settings: public key, collector (merchant) id, sender address. */
		publicConfig: jsonb('public_config').$type<Record<string, string>>().notNull().default({}),
		/** AES-GCM sealed JSON of secrets; never leaves the API. */
		sealedSecrets: text('sealed_secrets').notNull(),
		keyVersion: integer('key_version').notNull(),
		secretHint: text('secret_hint').notNull(),
		version: integer('version').notNull().default(1),
		isActive: boolean('is_active').notNull().default(true),
		lastVerifiedAt: ts('last_verified_at'),
		lastError: text('last_error'),
		updatedBy: uuid('updated_by'),
		createdAt: createdAt(),
		updatedAt: updatedAt()
	},
	(t) => [uniqueIndex('organization_integrations_uq').on(t.organizationId, t.provider, t.mode)]
);

/** Platform staff (`platform_superadmin`). User ids come from Supabase Auth. */
export const platformAdmins = app.table('platform_admins', {
	userId: uuid('user_id').primaryKey(),
	email: text('email').notNull(),
	createdAt: createdAt()
});

export const organizationMembers = app.table(
	'organization_members',
	{
		id: id(),
		organizationId: organizationId(),
		userId: uuid('user_id').notNull(),
		email: text('email').notNull(),
		role: orgRole('role').notNull(),
		status: memberStatus('status').notNull().default('active'),
		createdAt: createdAt()
	},
	(t) => [uniqueIndex('organization_members_uq').on(t.organizationId, t.userId), index('organization_members_user_idx').on(t.userId)]
);

// ─── CMS ───────────────────────────────────────────────────────────────────

/**
 * One row per block and locale. `content` is what the public site shows (null
 * until first published); editors work on `draft` and publish it explicitly.
 */
export const cmsBlocks = app.table(
	'cms_blocks',
	{
		id: id(),
		organizationId: organizationId(),
		key: text('key').notNull(),
		locale: text('locale').notNull().default('es-AR'),
		content: jsonb('content').$type<Record<string, unknown>>(),
		version: integer('version').notNull().default(1),
		publishedAt: ts('published_at'),
		publishedBy: uuid('published_by'),
		draft: jsonb('draft').$type<Record<string, unknown>>(),
		draftUpdatedAt: ts('draft_updated_at'),
		updatedBy: uuid('updated_by'),
		updatedAt: updatedAt()
	},
	(t) => [uniqueIndex('cms_blocks_uq').on(t.organizationId, t.key, t.locale)]
);

/** Every published version of a block, append-only. */
export const cmsBlockRevisions = app.table(
	'cms_block_revisions',
	{
		id: id(),
		organizationId: organizationId(),
		blockId: uuid('block_id')
			.notNull()
			.references(() => cmsBlocks.id),
		key: text('key').notNull(),
		locale: text('locale').notNull(),
		version: integer('version').notNull(),
		content: jsonb('content').$type<Record<string, unknown>>().notNull(),
		publishedBy: uuid('published_by'),
		publishedAt: ts('published_at').notNull().defaultNow()
	},
	(t) => [uniqueIndex('cms_block_revisions_uq').on(t.blockId, t.version)]
);

/** Images uploaded to the public media bucket, named by content hash under the organization. */
export const cmsMedia = app.table(
	'cms_media',
	{
		id: id(),
		organizationId: organizationId(),
		storagePath: text('storage_path').notNull().unique(),
		sha256: text('sha256').notNull(),
		contentType: text('content_type').notNull(),
		sizeBytes: integer('size_bytes').notNull(),
		filename: text('filename').notNull(),
		uploadedBy: uuid('uploaded_by'),
		createdAt: createdAt()
	},
	(t) => [uniqueIndex('cms_media_sha_uq').on(t.organizationId, t.sha256)]
);

// ─── Campaigns, rules and prizes ──────────────────────────────────────────

export const campaigns = app.table(
	'campaigns',
	{
		id: id(),
		organizationId: organizationId(),
		slug: text('slug').notNull(),
		title: text('title').notNull(),
		subtitle: text('subtitle'),
		summary: text('summary').notNull(),
		status: campaignStatus('status').notNull().default('draft'),
		timezone: text('timezone').notNull(),
		opensAt: ts('opens_at').notNull(),
		closesAt: ts('closes_at').notNull(),
		drawAt: ts('draw_at'),
		streamUrl: text('stream_url'),
		replayUrl: text('replay_url'),
		/** Free text describing the authorized modality, filled in from the legal approval. */
		modality: text('modality'),
		authority: text('authority'),
		requiredApprovals: approvalKind('required_approvals').array().notNull().default(sql`'{legal,psp}'`),
		/** Demo campaigns are labelled as such everywhere they are shown. */
		isDemo: boolean('is_demo').notNull().default(false),
		/** Next coupon number, from 0; incremented under a row lock and always below 10^entry_digits (ADR 0014). */
		nextEntryNumber: integer('next_entry_number').notNull().default(0),
		/** Coupon digits: the pool is 0 … 10^entry_digits − 1 (ADR 0014). */
		entryDigits: smallint('entry_digits').notNull().default(4),
		seo: jsonb('seo').$type<{ title?: string; description?: string; image?: string }>().notNull().default({}),
		/** Optional video of what is raffled: `media:<path>` of an uploaded video or a YouTube link (S9). */
		video: text('video'),
		/** Products its page shows, in catalog order; empty shows every active product (2026-10-18b). */
		productIds: uuid('product_ids').array().notNull().default(sql`'{}'::uuid[]`),
		createdAt: createdAt(),
		updatedAt: updatedAt()
	},
	(t) => [
		uniqueIndex('campaigns_slug_uq').on(t.organizationId, t.slug),
		index('campaigns_status_idx').on(t.organizationId, t.status),
		check('campaigns_entry_digits_check', sql`${t.entryDigits} between 1 and 6`)
	]
);

export const campaignApprovals = app.table(
	'campaign_approvals',
	{
		id: id(),
		organizationId: organizationId(),
		campaignId: uuid('campaign_id')
			.notNull()
			.references(() => campaigns.id),
		kind: approvalKind('kind').notNull(),
		status: approvalStatus('status').notNull().default('pending'),
		reference: text('reference'),
		authority: text('authority'),
		notes: text('notes'),
		decidedAt: ts('decided_at'),
		decidedBy: uuid('decided_by'),
		createdAt: createdAt()
	},
	(t) => [uniqueIndex('campaign_approvals_uq').on(t.campaignId, t.kind)]
);

export const campaignRuleVersions = app.table(
	'campaign_rule_versions',
	{
		id: id(),
		organizationId: organizationId(),
		campaignId: uuid('campaign_id')
			.notNull()
			.references(() => campaigns.id),
		version: integer('version').notNull(),
		status: ruleVersionStatus('status').notNull().default('draft'),
		bodyMarkdown: text('body_markdown').notNull(),
		eligibility: jsonb('eligibility').$type<{ minAge: number; residency: string; excluded: string[] }>().notNull(),
		entryRule: jsonb('entry_rule').$type<EntryAllocationRule>().notNull(),
		contentHash: text('content_hash'),
		lockedAt: ts('locked_at'),
		approvedBy: uuid('approved_by'),
		announcement: text('announcement'),
		createdAt: createdAt()
	},
	(t) => [uniqueIndex('campaign_rule_versions_uq').on(t.campaignId, t.version)]
);

export const campaignMedia = app.table('campaign_media', {
	id: id(),
	organizationId: organizationId(),
	campaignId: uuid('campaign_id')
		.notNull()
		.references(() => campaigns.id),
	kind: mediaKind('kind').notNull(),
	role: text('role').notNull().default('gallery'),
	url: text('url').notNull(),
	alt: text('alt').notNull(),
	position: integer('position').notNull().default(0),
	createdAt: createdAt()
});

export const campaignFaqs = app.table('campaign_faqs', {
	id: id(),
	organizationId: organizationId(),
	campaignId: uuid('campaign_id').references(() => campaigns.id),
	question: text('question').notNull(),
	answer: text('answer').notNull(),
	position: integer('position').notNull().default(0)
});

export const prizes = app.table(
	'prizes',
	{
		id: id(),
		organizationId: organizationId(),
		campaignId: uuid('campaign_id')
			.notNull()
			.references(() => campaigns.id),
		position: integer('position').notNull(),
		kind: prizeKind('kind').notNull(),
		title: text('title').notNull(),
		description: text('description'),
		declaredValueMinor: bigint('declared_value_minor', { mode: 'number' }).notNull(),
		currency: text('currency').notNull().default('ARS'),
		quantity: integer('quantity').notNull().default(1),
		alternatesCount: integer('alternates_count').notNull().default(1),
		/** Decided by the Quiniela extracts or recorded by hand (ADR 0014 §2). */
		mechanism: prizeMechanism('mechanism').notNull().default('manual'),
		conditions: text('conditions'),
		imageUrl: text('image_url'),
		/** Optional video of the prize, like the campaign's; editable after the campaign opens (presentation only). */
		video: text('video'),
		createdAt: createdAt()
	},
	(t) => [index('prizes_campaign_idx').on(t.campaignId, t.position)]
);

export const prizeAwards = app.table(
	'prize_awards',
	{
		id: id(),
		organizationId: organizationId(),
		campaignId: uuid('campaign_id')
			.notNull()
			.references(() => campaigns.id),
		prizeId: uuid('prize_id')
			.notNull()
			.references(() => prizes.id),
		/** Which unit of the prize (1..quantity). */
		slot: integer('slot').notNull(),
		role: awardRole('role').notNull(),
		rank: integer('rank').notNull(),
		entryId: uuid('entry_id').references(() => participationEntries.id),
		status: awardStatus('status').notNull().default('pending_verification'),
		decidedAt: ts('decided_at'),
		decidedBy: uuid('decided_by'),
		/** Who entered the result of the authorized mechanism. */
		recordedBy: uuid('recorded_by'),
		notes: text('notes'),
		createdAt: createdAt()
	},
	(t) => [uniqueIndex('prize_awards_uq').on(t.prizeId, t.slot, t.role, t.rank), uniqueIndex('prize_awards_entry_uq').on(t.campaignId, t.entryId)]
);

/** One delivery per accepted award; its history lives in the audit log. */
export const prizeFulfillments = app.table(
	'prize_fulfillments',
	{
		id: id(),
		organizationId: organizationId(),
		awardId: uuid('award_id')
			.notNull()
			.references(() => prizeAwards.id),
		status: fulfillmentStatus('status').notNull().default('pending'),
		scheduledFor: ts('scheduled_for'),
		deliveredAt: ts('delivered_at'),
		evidenceUrl: text('evidence_url'),
		notes: text('notes'),
		updatedBy: uuid('updated_by'),
		createdAt: createdAt(),
		updatedAt: updatedAt()
	},
	(t) => [uniqueIndex('prize_fulfillments_award_uq').on(t.awardId)]
);

// ─── Catalog ───────────────────────────────────────────────────────────────

export const products = app.table(
	'products',
	{
		id: id(),
		organizationId: organizationId(),
		slug: text('slug').notNull(),
		name: text('name').notNull(),
		description: text('description').notNull(),
		kind: productKind('kind').notNull(),
		status: productStatus('status').notNull().default('draft'),
		imageUrl: text('image_url'),
		position: integer('position').notNull().default(0),
		createdAt: createdAt(),
		updatedAt: updatedAt()
	},
	(t) => [uniqueIndex('products_slug_uq').on(t.organizationId, t.slug)]
);

export const productVariants = app.table('product_variants', {
	id: id(),
	organizationId: organizationId(),
	productId: uuid('product_id')
		.notNull()
		.references(() => products.id),
	sku: text('sku').notNull(),
	name: text('name').notNull(),
	priceMinor: bigint('price_minor', { mode: 'number' }).notNull(),
	currency: text('currency').notNull().default('ARS'),
	stock: integer('stock'),
	maxPerOrder: integer('max_per_order').notNull().default(5),
	availableFrom: ts('available_from'),
	availableUntil: ts('available_until'),
	active: boolean('active').notNull().default(true),
	createdAt: createdAt()
});

/** Private files (e.g. the PDF manual) served only through signed, expiring grants. */
export const productAssets = app.table('product_assets', {
	id: id(),
	organizationId: organizationId(),
	productId: uuid('product_id')
		.notNull()
		.references(() => products.id),
	storagePath: text('storage_path').notNull(),
	filename: text('filename').notNull(),
	contentType: text('content_type').notNull(),
	sizeBytes: integer('size_bytes').notNull(),
	createdAt: createdAt()
});

export const offers = app.table('offers', {
	id: id(),
	organizationId: organizationId(),
	kind: offerKind('kind').notNull(),
	anchorProductId: uuid('anchor_product_id').references(() => products.id),
	title: text('title').notNull(),
	description: text('description'),
	active: boolean('active').notNull().default(true),
	createdAt: createdAt()
});

export const offerItems = app.table(
	'offer_items',
	{
		organizationId: organizationId(),
		offerId: uuid('offer_id')
			.notNull()
			.references(() => offers.id),
		variantId: uuid('variant_id')
			.notNull()
			.references(() => productVariants.id),
		position: integer('position').notNull().default(0),
		pitch: text('pitch')
	},
	(t) => [primaryKey({ columns: [t.offerId, t.variantId] })]
);

// ─── Contacts and consent ─────────────────────────────────────────────────

export const contacts = app.table('contacts', {
	id: id(),
	organizationId: organizationId(),
	firstName: text('first_name').notNull(),
	lastName: text('last_name').notNull(),
	email: text('email').notNull(),
	emailVerifiedAt: ts('email_verified_at'),
	phone: text('phone'),
	createdAt: createdAt(),
	updatedAt: updatedAt()
});

export const contactIdentifiers = app.table(
	'contact_identifiers',
	{
		id: id(),
		organizationId: organizationId(),
		contactId: uuid('contact_id')
			.notNull()
			.references(() => contacts.id),
		documentType: documentType('document_type').notNull(),
		documentNumber: text('document_number').notNull(),
		createdAt: createdAt()
	},
	(t) => [uniqueIndex('contact_identifiers_uq').on(t.organizationId, t.documentType, t.documentNumber)]
);

export const contactConsents = app.table('contact_consents', {
	id: id(),
	organizationId: organizationId(),
	contactId: uuid('contact_id')
		.notNull()
		.references(() => contacts.id),
	purpose: consentPurpose('purpose').notNull(),
	granted: boolean('granted').notNull(),
	policyVersion: text('policy_version').notNull(),
	source: text('source').notNull(),
	orderId: uuid('order_id'),
	recordedAt: createdAt()
});

// ─── Orders and payments ──────────────────────────────────────────────────

/**
 * Buyer data as entered on this order. The contact's email is never overwritten
 * by a later checkout: lookup codes always go to the first (or verified)
 * address, so typing someone else's DNI cannot redirect their codes.
 */
export interface BuyerSnapshot {
	firstName: string;
	lastName: string;
	email: string;
	phone: string | null;
	/**
	 * Where the buyer lives (S7). Orders placed before it was asked have neither.
	 * `country` (ISO alpha-2, S6) is absent on orders placed before it was asked: read it
	 * with `buyerCountry`, which answers the organization's country.
	 */
	country?: string;
	province?: string;
	city?: string;
}

export interface PricingSnapshot {
	lines: { variantId: string; name: string; quantity: number; unitPriceMinor: number; lineTotalMinor: number }[];
	subtotalMinor: number;
	deliveryFeeMinor: number;
	totalMinor: number;
	currency: string;
	pricedAt: string;
}

export const orders = app.table(
	'orders',
	{
		id: id(),
		organizationId: organizationId(),
		reference: text('reference').notNull(),
		accessCodeHash: text('access_code_hash').notNull(),
		contactId: uuid('contact_id')
			.notNull()
			.references(() => contacts.id),
		buyer: jsonb('buyer').$type<BuyerSnapshot>().notNull(),
		campaignId: uuid('campaign_id').references(() => campaigns.id),
		ruleVersionId: uuid('rule_version_id').references(() => campaignRuleVersions.id),
		status: orderStatus('status').notNull().default('pending_payment'),
		currency: text('currency').notNull(),
		subtotalMinor: bigint('subtotal_minor', { mode: 'number' }).notNull(),
		deliveryFeeMinor: bigint('delivery_fee_minor', { mode: 'number' }).notNull(),
		totalMinor: bigint('total_minor', { mode: 'number' }).notNull(),
		deliveryMethod: deliveryMethod('delivery_method').notNull(),
		deliveryAddress: jsonb('delivery_address').$type<Record<string, string>>(),
		pricingSnapshot: jsonb('pricing_snapshot').$type<PricingSnapshot>().notNull(),
		paymentProvider: text('payment_provider').notNull(),
		providerPreferenceId: text('provider_preference_id'),
		/** Chances the cart quoted when the order was created; they hold coupons while it is payable (ADR 0014). */
		reservedEntries: integer('reserved_entries').notNull().default(0),
		paidAt: ts('paid_at'),
		expiresAt: ts('expires_at').notNull(),
		createdAt: createdAt(),
		updatedAt: updatedAt()
	},
	(t) => [
		uniqueIndex('orders_reference_uq').on(t.organizationId, t.reference),
		index('orders_status_idx').on(t.organizationId, t.status, t.createdAt),
		index('orders_contact_idx').on(t.organizationId, t.contactId),
		index('orders_campaign_status_idx').on(t.campaignId, t.status, t.expiresAt)
	]
);

export const orderItems = app.table('order_items', {
	id: id(),
	organizationId: organizationId(),
	orderId: uuid('order_id')
		.notNull()
		.references(() => orders.id),
	productId: uuid('product_id')
		.notNull()
		.references(() => products.id),
	variantId: uuid('variant_id')
		.notNull()
		.references(() => productVariants.id),
	name: text('name').notNull(),
	kind: productKind('kind').notNull(),
	quantity: integer('quantity').notNull(),
	unitPriceMinor: bigint('unit_price_minor', { mode: 'number' }).notNull(),
	lineTotalMinor: bigint('line_total_minor', { mode: 'number' }).notNull()
});

export const payments = app.table(
	'payments',
	{
		id: id(),
		organizationId: organizationId(),
		orderId: uuid('order_id')
			.notNull()
			.references(() => orders.id),
		provider: text('provider').notNull(),
		providerPaymentId: text('provider_payment_id').notNull(),
		status: paymentStatus('status').notNull(),
		statusDetail: text('status_detail'),
		amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
		currency: text('currency').notNull(),
		collectorId: text('collector_id'),
		approvedAt: ts('approved_at'),
		/** Provider-reported financial facts (FR-PAY-06). Null until the provider reports them. */
		feeMinor: bigint('fee_minor', { mode: 'number' }),
		netMinor: bigint('net_minor', { mode: 'number' }),
		refundedMinor: bigint('refunded_minor', { mode: 'number' }).notNull().default(0),
		releaseDate: ts('release_date'),
		releaseStatus: text('release_status'),
		providerUpdatedAt: ts('provider_updated_at'),
		createdAt: createdAt(),
		updatedAt: updatedAt()
	},
	(t) => [
		uniqueIndex('payments_provider_uq').on(t.organizationId, t.provider, t.providerPaymentId),
		index('payments_order_idx').on(t.orderId),
		index('payments_updated_idx').on(t.organizationId, t.updatedAt)
	]
);

/** Every webhook received, valid or not, for audit and replay analysis. */
export const paymentEvents = app.table(
	'payment_events',
	{
		id: id(),
		organizationId: organizationId(),
		provider: text('provider').notNull(),
		requestId: text('request_id'),
		topic: text('topic').notNull(),
		providerPaymentId: text('provider_payment_id'),
		signatureValid: boolean('signature_valid').notNull(),
		outcome: text('outcome').notNull(),
		detail: text('detail'),
		receivedAt: createdAt()
	},
	(t) => [index('payment_events_payment_idx').on(t.organizationId, t.providerPaymentId)]
);

// ─── Reconciliation ───────────────────────────────────────────────────────

export interface ReconciliationSummary {
	/** Provider payments examined, and how many matched the platform exactly. */
	examined?: number;
	matched?: number;
	/** Provider payments that are not this platform's sales. */
	ignored?: number;
	discrepancies?: number;
	/** Open items that a fresh provider read showed were already settled. */
	cleared?: number;
	/** Settlement uploads: the file as received. */
	file?: { name: string; sha256: string; rows: number; skipped: number; inserted: number };
}

/** One execution: scheduled or manual operations check, or a settlement report upload. */
export const reconciliationRuns = app.table(
	'reconciliation_runs',
	{
		id: id(),
		organizationId: organizationId(),
		kind: reconciliationRunKind('kind').notNull(),
		trigger: reconciliationRunTrigger('trigger').notNull(),
		status: reconciliationRunStatus('status').notNull().default('running'),
		windowFrom: ts('window_from').notNull(),
		windowTo: ts('window_to').notNull(),
		startedBy: uuid('started_by'),
		startedAt: ts('started_at').notNull().defaultNow(),
		finishedAt: ts('finished_at'),
		summary: jsonb('summary').$type<ReconciliationSummary>().notNull().default({}),
		error: text('error')
	},
	(t) => [
		index('reconciliation_runs_org_idx').on(t.organizationId, t.kind, t.startedAt),
		// One run of each kind at a time per organization, across API instances.
		uniqueIndex('reconciliation_runs_running_uq').on(t.organizationId, t.kind).where(sql`${t.status} = 'running'`)
	]
);

/** A difference between the platform and the provider, kept open until a person resolves it. */
export const reconciliationItems = app.table(
	'reconciliation_items',
	{
		id: id(),
		organizationId: organizationId(),
		/** Null for items raised by the platform itself, such as a paid order left without coupons (ADR 0014). */
		firstRunId: uuid('first_run_id').references(() => reconciliationRuns.id),
		lastRunId: uuid('last_run_id').references(() => reconciliationRuns.id),
		kind: discrepancyKind('kind').notNull(),
		severity: discrepancySeverity('severity').notNull(),
		fingerprint: text('fingerprint').notNull(),
		providerPaymentId: text('provider_payment_id'),
		orderReference: text('order_reference'),
		orderId: uuid('order_id').references(() => orders.id),
		expected: jsonb('expected').$type<Record<string, string | number | null>>().notNull(),
		observed: jsonb('observed').$type<Record<string, string | number | null>>().notNull(),
		status: reconciliationItemStatus('status').notNull().default('open'),
		resolution: reconciliationResolution('resolution'),
		resolutionNote: text('resolution_note'),
		resolvedBy: uuid('resolved_by'),
		resolvedAt: ts('resolved_at'),
		firstSeenAt: ts('first_seen_at').notNull().defaultNow(),
		lastSeenAt: ts('last_seen_at').notNull().defaultNow()
	},
	(t) => [
		uniqueIndex('reconciliation_items_open_uq').on(t.organizationId, t.fingerprint).where(sql`${t.status} = 'open'`),
		index('reconciliation_items_status_idx').on(t.organizationId, t.status, t.lastSeenAt)
	]
);

/** Movements from the provider's settlement report. Append-only: a report is evidence. */
export const paymentSettlements = app.table(
	'payment_settlements',
	{
		id: id(),
		organizationId: organizationId(),
		provider: text('provider').notNull(),
		runId: uuid('run_id')
			.notNull()
			.references(() => reconciliationRuns.id),
		rowKey: text('row_key').notNull(),
		providerPaymentId: text('provider_payment_id').notNull(),
		externalReference: text('external_reference'),
		transactionType: text('transaction_type').notNull(),
		grossMinor: bigint('gross_minor', { mode: 'number' }).notNull(),
		feeMinor: bigint('fee_minor', { mode: 'number' }).notNull(),
		netMinor: bigint('net_minor', { mode: 'number' }).notNull(),
		currency: text('currency').notNull(),
		transactionAt: ts('transaction_at'),
		settledAt: ts('settled_at'),
		createdAt: createdAt()
	},
	(t) => [
		uniqueIndex('payment_settlements_row_uq').on(t.organizationId, t.provider, t.rowKey),
		index('payment_settlements_payment_idx').on(t.organizationId, t.providerPaymentId)
	]
);

// ─── Participations ────────────────────────────────────────────────────────

/** One row per order that produced entries: the second idempotency guard (AC-01). */
export const entryAllocations = app.table(
	'entry_allocations',
	{
		id: id(),
		organizationId: organizationId(),
		campaignId: uuid('campaign_id')
			.notNull()
			.references(() => campaigns.id),
		orderId: uuid('order_id')
			.notNull()
			.references(() => orders.id),
		ruleVersionId: uuid('rule_version_id')
			.notNull()
			.references(() => campaignRuleVersions.id),
		entryCount: integer('entry_count').notNull(),
		createdAt: createdAt()
	},
	(t) => [uniqueIndex('entry_allocations_order_uq').on(t.orderId)]
);

export const participationEntries = app.table(
	'participation_entries',
	{
		id: id(),
		organizationId: organizationId(),
		campaignId: uuid('campaign_id')
			.notNull()
			.references(() => campaigns.id),
		entryNumber: integer('entry_number').notNull(),
		contactId: uuid('contact_id')
			.notNull()
			.references(() => contacts.id),
		orderId: uuid('order_id')
			.notNull()
			.references(() => orders.id),
		holderPseudonym: text('holder_pseudonym').notNull(),
		status: entryStatus('status').notNull().default('eligible'),
		createdAt: createdAt()
	},
	(t) => [
		uniqueIndex('participation_entries_number_uq').on(t.campaignId, t.entryNumber),
		index('participation_entries_contact_idx').on(t.organizationId, t.contactId)
	]
);

/** Append-only history; updates and deletes are blocked by a trigger. */
export const entryLedgerEvents = app.table('entry_ledger_events', {
	id: id(),
	organizationId: organizationId(),
	campaignId: uuid('campaign_id')
		.notNull()
		.references(() => campaigns.id),
	entryId: uuid('entry_id')
		.notNull()
		.references(() => participationEntries.id),
	event: ledgerEvent('event').notNull(),
	reason: text('reason').notNull(),
	orderId: uuid('order_id').references(() => orders.id),
	createdAt: createdAt()
});

export const drawManifests = app.table(
	'draw_manifests',
	{
		id: id(),
		organizationId: organizationId(),
		campaignId: uuid('campaign_id')
			.notNull()
			.references(() => campaigns.id),
		ruleVersion: integer('rule_version').notNull(),
		sha256: text('sha256').notNull(),
		content: text('content').notNull(),
		eligibleCount: integer('eligible_count').notNull(),
		voidCount: integer('void_count').notNull(),
		closedAt: ts('closed_at').notNull(),
		publishedAt: ts('published_at'),
		createdAt: createdAt()
	},
	(t) => [uniqueIndex('draw_manifests_campaign_uq').on(t.campaignId)]
);

/** Append-only public timeline of the draw: commitment, mechanism, act, results. */
export const drawEvents = app.table('draw_events', {
	id: id(),
	organizationId: organizationId(),
	campaignId: uuid('campaign_id')
		.notNull()
		.references(() => campaigns.id),
	kind: text('kind').notNull(),
	title: text('title').notNull(),
	detail: text('detail'),
	evidenceUrl: text('evidence_url'),
	recordedBy: uuid('recorded_by'),
	occurredAt: ts('occurred_at').notNull(),
	createdAt: createdAt()
});

/**
 * The official Quiniela draw that decides the `quiniela` prizes of a campaign
 * round (ADR 0014 §3). Append-only: the extracts, as published, in order.
 */
export const quinielaDraws = app.table(
	'quiniela_draws',
	{
		id: id(),
		organizationId: organizationId(),
		campaignId: uuid('campaign_id')
			.notNull()
			.references(() => campaigns.id),
		round: integer('round').notNull().default(1),
		/** Which draw, for example "Quiniela de la Ciudad, Nocturna". */
		source: text('source').notNull(),
		/** The official time of the draw, stored UTC; later than the manifest publication (ADR 0014 §3). */
		drawnAt: ts('drawn_at').notNull(),
		/** The 20 extracts, 1st to 20th, each 0000–9999. */
		extracts: integer('extracts').array().notNull(),
		evidenceUrl: text('evidence_url').notNull(),
		/** SHA-256 of the published manifest the extracts were matched against. */
		manifestSha256: text('manifest_sha256').notNull(),
		recordedBy: uuid('recorded_by'),
		createdAt: createdAt()
	},
	(t) => [
		uniqueIndex('quiniela_draws_round_uq').on(t.campaignId, t.round),
		check('quiniela_draws_round_check', sql`${t.round} >= 1`),
		check('quiniela_draws_extracts_check', sql`cardinality(${t.extracts}) = 20 and 0 <= all(${t.extracts}) and 9999 >= all(${t.extracts})`)
	]
);

// ─── Private lookup and downloads ─────────────────────────────────────────

export const lookupChallenges = app.table('lookup_challenges', {
	id: id(),
	organizationId: organizationId(),
	/** Null when the document is unknown: the challenge exists but can never succeed. */
	contactId: uuid('contact_id').references(() => contacts.id),
	codeHash: text('code_hash').notNull(),
	attempts: integer('attempts').notNull().default(0),
	expiresAt: ts('expires_at').notNull(),
	consumedAt: ts('consumed_at'),
	createdAt: createdAt()
});

export const lookupSessions = app.table('lookup_sessions', {
	id: id(),
	organizationId: organizationId(),
	contactId: uuid('contact_id')
		.notNull()
		.references(() => contacts.id),
	/** Set when the session was opened with a receipt code: access is limited to that order. */
	orderId: uuid('order_id').references(() => orders.id),
	tokenHash: text('token_hash').notNull().unique(),
	expiresAt: ts('expires_at').notNull(),
	createdAt: createdAt()
});

export const downloadGrants = app.table('download_grants', {
	id: id(),
	organizationId: organizationId(),
	orderId: uuid('order_id')
		.notNull()
		.references(() => orders.id),
	productAssetId: uuid('product_asset_id')
		.notNull()
		.references(() => productAssets.id),
	tokenHash: text('token_hash').notNull().unique(),
	expiresAt: ts('expires_at').notNull(),
	maxDownloads: integer('max_downloads').notNull().default(5),
	downloadCount: integer('download_count').notNull().default(0),
	createdAt: createdAt()
});

// ─── Live operations feed ─────────────────────────────────────────────────

/**
 * One counter per organization. Publishing an event increments it under a row
 * lock held until commit, so sequence order is commit order and a client that
 * resumes after sequence N can never miss an event numbered below N.
 */
export const opsSequences = app.table('ops_sequences', {
	organizationId: uuid('organization_id')
		.primaryKey()
		.references(() => organizations.id, { onDelete: 'restrict' }),
	lastSequence: bigint('last_sequence', { mode: 'number' }).notNull().default(0)
});

/** Change notices for the dashboard (no personal data). A trigger NOTIFYs on insert. */
export const opsEvents = app.table(
	'ops_events',
	{
		organizationId: organizationId(),
		sequence: bigint('sequence', { mode: 'number' }).notNull(),
		kind: text('kind').$type<OpsEventKind>().notNull(),
		subjectId: uuid('subject_id'),
		createdAt: createdAt()
	},
	(t) => [primaryKey({ columns: [t.organizationId, t.sequence] }), index('ops_events_created_idx').on(t.createdAt)]
);

// ─── Outbox, notifications and audit ──────────────────────────────────────

export const outboxEvents = app.table(
	'outbox_events',
	{
		id: id(),
		organizationId: organizationId(),
		topic: text('topic').notNull(),
		dedupeKey: text('dedupe_key').notNull().unique(),
		payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
		status: outboxStatus('status').notNull().default('pending'),
		attempts: integer('attempts').notNull().default(0),
		availableAt: ts('available_at').notNull().defaultNow(),
		lockedAt: ts('locked_at'),
		lockedBy: text('locked_by'),
		lastError: text('last_error'),
		processedAt: ts('processed_at'),
		createdAt: createdAt()
	},
	(t) => [index('outbox_events_pending_idx').on(t.status, t.availableAt)]
);

export const notifications = app.table('notifications', {
	id: id(),
	organizationId: organizationId(),
	contactId: uuid('contact_id').references(() => contacts.id),
	outboxEventId: uuid('outbox_event_id').references(() => outboxEvents.id),
	channel: text('channel').notNull().default('email'),
	template: text('template').notNull(),
	locale: text('locale').notNull(),
	toAddress: text('to_address').notNull(),
	status: notificationStatus('status').notNull().default('queued'),
	providerMessageId: text('provider_message_id'),
	createdAt: createdAt(),
	sentAt: ts('sent_at')
});

export const notificationAttempts = app.table('notification_attempts', {
	id: id(),
	organizationId: organizationId(),
	notificationId: uuid('notification_id')
		.notNull()
		.references(() => notifications.id),
	attempt: integer('attempt').notNull(),
	ok: boolean('ok').notNull(),
	error: text('error'),
	createdAt: createdAt()
});

/** Append-only. `organization_id` is null for platform-level actions. */
export const auditEvents = app.table(
	'audit_events',
	{
		id: id(),
		organizationId: uuid('organization_id').references(() => organizations.id),
		actorType: text('actor_type').notNull(),
		actorId: text('actor_id'),
		action: text('action').notNull(),
		targetType: text('target_type').notNull(),
		targetId: text('target_id'),
		metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
		createdAt: createdAt()
	},
	(t) => [index('audit_events_org_idx').on(t.organizationId, t.createdAt)]
);

// ─── Reference data ───────────────────────────────────────────────────────

/*
 * World locations from GeoNames (CC BY 4.0), loaded by `pnpm db:geo` (S6, ADR 0012).
 * Platform reference data, not business data: no organization_id and no RLS.
 * The app role may only read them; the owner connection writes them.
 */

export const geoCountries = app.table('geo_countries', {
	/** ISO 3166-1 alpha-2. */
	code: text('code').primaryKey(),
	iso3: text('iso3').notNull(),
	/** GeoNames' English name; the web shows the Spanish one from Intl.DisplayNames. */
	name: text('name').notNull(),
	continent: text('continent').notNull(),
	geonameId: integer('geoname_id'),
	updatedAt: updatedAt()
});

/** First-level subdivisions (provinces, states, regions). */
export const geoSubdivisions = app.table(
	'geo_subdivisions',
	{
		countryCode: text('country_code')
			.notNull()
			.references(() => geoCountries.code),
		/** GeoNames admin1 code, unique inside the country. */
		code: text('code').notNull(),
		name: text('name').notNull(),
		asciiName: text('ascii_name').notNull(),
		geonameId: integer('geoname_id'),
		updatedAt: updatedAt()
	},
	(t) => [primaryKey({ columns: [t.countryCode, t.code] })]
);

/** Cities with more than 1,000 inhabitants. `search_name` is the name without case or accents (locationSearchKey). */
export const geoCities = app.table(
	'geo_cities',
	{
		geonameId: integer('geoname_id').primaryKey(),
		countryCode: text('country_code')
			.notNull()
			.references(() => geoCountries.code),
		subdivisionCode: text('subdivision_code'),
		name: text('name').notNull(),
		asciiName: text('ascii_name').notNull(),
		searchName: text('search_name').notNull(),
		population: integer('population').notNull().default(0),
		updatedAt: updatedAt()
	},
	(t) => [
		index('geo_cities_search_idx').on(t.countryCode, t.searchName.op('text_pattern_ops')),
		index('geo_cities_subdivision_search_idx').on(t.countryCode, t.subdivisionCode, t.searchName.op('text_pattern_ops'))
	]
);
