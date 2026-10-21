import type { PublicVideo } from '@sortea/domain';

/** Shapes returned by the API, limited to what the web uses. */
export interface SiteData {
	organization: { name: string; slug: string; locale: string; timezone: string; currency: string };
	theme: { css: string; defaultMode: 'dark' | 'light' };
	content: {
		brand?: { logo: string | null; logoAlt: string; tagline: string };
		home?: HomeContent;
		seo?: { title: string; description: string; image: string | null };
		announcement?: { enabled: boolean; text: string; linkUrl: string | null; linkLabel?: string | null };
		gallery?: GalleryContent;
		'legal.terms'?: LegalContent;
		'legal.privacy'?: LegalContent;
	};
	contact: { email?: string; phone?: string; whatsapp?: string; address?: string; city?: string };
	social: { instagram?: string; youtube?: string; tiktok?: string; facebook?: string };
	delivery: { pickupEnabled: boolean; shippingEnabled: boolean; shippingFeeMinor: number; pickupNote?: string };
	legal: { termsVersion: string; privacyVersion: string };
	faqs: { id: string; question: string; answer: string }[];
	/** The API runs the local compliance demo mode (ADR 0013). */
	complianceDemo: boolean;
	serverTime: string;
}

export interface HomeContent {
	/** Signature treatments are opt-in per organization; `simple` is the default. */
	heroStyle?: 'garage' | 'simple';
	processStyle?: 'pistons' | 'list';
	heroTitle: string;
	heroLead: string;
	heroImage: string | null;
	heroImageAlt?: string | null;
	heroVideoUrl?: string | null;
	servicesTitle?: string | null;
	services: { title: string; body: string }[];
	processTitle?: string | null;
	process: { title: string; body: string }[];
	ctaTitle?: string | null;
	ctaBody?: string | null;
}

/** Photos by others carry their credit; the site shows it next to each photo. */
export interface GalleryCredit {
	author: string;
	license: string;
	sourceUrl: string;
}

export interface GalleryContent {
	enabled: boolean;
	/** The page can be live while the home teaser and the menu link stay off. */
	showOnHome?: boolean;
	showInMenu?: boolean;
	title: string;
	lead?: string | null;
	/** Shown near the top, e.g. to say the photos are examples. */
	note?: string | null;
	items: { image: string; alt: string; title: string; body?: string | null; credit?: GalleryCredit | null }[];
}

/** Written by the organization in the CMS; versioned because buyers accept a specific version. */
export interface LegalContent {
	version: string;
	sections: { title: string; body: string }[];
}

export interface CampaignSummary {
	slug: string;
	title: string;
	subtitle: string | null;
	summary: string;
	status: string;
	isDemo: boolean;
	opensAt: string;
	closesAt: string;
	drawAt: string | null;
	/** Resolved by the API: bucket URL of an upload or YouTube embed (S9). */
	video: PublicVideo | null;
	mainPrize: string | null;
	prizeCount: number;
	prizes: { position: number; kind: string; title: string; quantity: number; imageUrl: string | null; video: PublicVideo | null }[];
}

export interface CampaignDetail {
	slug: string;
	/** Products its page shows; empty shows every active product. */
	productIds: string[];
	title: string;
	subtitle: string | null;
	summary: string;
	status: string;
	isDemo: boolean;
	timezone: string;
	opensAt: string;
	closesAt: string;
	drawAt: string | null;
	streamUrl: string | null;
	replayUrl: string | null;
	video: PublicVideo | null;
	modality: string | null;
	authority: string | null;
	seo: { title?: string; description?: string; image?: string };
	acceptingParticipations: boolean;
	compliance: { allowed: boolean; demo: boolean; approvals: { kind: 'legal' | 'psp'; status: string; authority: string | null; reference: string | null; decidedAt: string | null }[] };
	rules: { version: number; status: string; body: string; eligibility: { minAge: number; residency: string; excluded: string[] }; contentHash: string | null; lockedAt: string | null } | null;
	qualifyingVariants: string[];
	/** From the locked rules only; empty until the campaign opens. */
	chancesPerUnit: Record<string, number>;
	maxChancesPerIdentity: number | null;
	/** Coupon pool (ADR 0014 §1): digits, what remains, and whether nothing does. */
	entryDigits: number;
	couponsRemaining: number;
	soldOut: boolean;
	prizes: { position: number; kind: string; title: string; description: string | null; declaredValueMinor: number; currency: string; quantity: number; conditions: string | null; imageUrl: string | null; video: PublicVideo | null }[];
	media: { kind: string; role: string; url: string; alt: string }[];
	faqs: { question: string; answer: string }[];
	serverTime: string;
}

export interface Transparency {
	slug: string;
	title: string;
	status: string;
	isDemo: boolean;
	closesAt: string;
	drawAt: string | null;
	streamUrl: string | null;
	replayUrl: string | null;
	entryDigits: number;
	totals: { eligibleEntries: number; participants: number; voidedEntries: number };
	ruleVersions: { version: number; status: string; lockedAt: string | null; contentHash: string | null; announcement: string | null }[];
	manifest: { sha256: string; eligibleCount: number; voidCount: number; closedAt: string; publishedAt: string } | null;
	timeline: { kind: string; title: string; detail: string | null; evidenceUrl: string | null; occurredAt: string }[];
	/** Official Quiniela draws, one per round, public once recorded (ADR 0014 §3). */
	quinielaDraws: { round: number; source: string; drawnAt: string; extracts: number[]; evidenceUrl: string; recordedAt: string }[];
	awards: {
		prize: string;
		slot: number;
		role: string;
		status: string;
		entryNumber: number | null;
		/** The extract (1-20) that matched a quiniela coupon; null for manual prizes. */
		extractPosition: number | null;
		fulfillment: { status: string; deliveredAt: string | null; evidenceUrl: string | null } | null;
	}[];
	/** Quiniela units the draw left without a match, once results are published. */
	vacantSlots: { prize: string; slot: number }[];
}

export interface Product {
	id: string;
	slug: string;
	name: string;
	description: string;
	kind: 'digital' | 'physical';
	imageUrl: string | null;
	variants: { id: string; name: string; priceMinor: number; currency: string; inStock: boolean; maxPerOrder: number }[];
	upsells: { variantId: string; pitch: string | null; title: string }[];
}

export interface Quote {
	ok: boolean;
	/** Why the API refuses the cart; `max` comes with `over_max_per_order`. */
	errors?: { code: string; variantId?: string; max?: number }[];
	currency?: string;
	lines?: { variantId: string; name: string; kind: 'digital' | 'physical'; quantity: number; unitPriceMinor: number; lineTotalMinor: number }[];
	subtotalMinor?: number;
	deliveryFeeMinor?: number;
	totalMinor?: number;
	requiresDelivery?: boolean;
	delivery?: SiteData['delivery'];
	/** Counted by the API with the locked rules; null when no campaign accepts participations. */
	chances?: {
		campaign: { slug: string; title: string };
		lines: { variantId: string; chances: number }[];
		total: number;
		maxPerIdentity: number | null;
		/** Coupons left in the campaign's pool; checkout refuses a cart whose total exceeds it. */
		remaining: number;
	} | null;
}

export interface ApiErrorBody {
	error: { code: string; message: string; details?: unknown };
}
