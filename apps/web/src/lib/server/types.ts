/** Shapes returned by the API, limited to what the web uses. */
export interface SiteData {
	organization: { name: string; slug: string; locale: string; timezone: string; currency: string };
	theme: { css: string; defaultMode: 'dark' | 'light' };
	content: {
		brand?: { logo: string | null; logoAlt: string; tagline: string };
		home?: HomeContent;
	};
	contact: { email?: string; phone?: string; whatsapp?: string; address?: string; city?: string };
	social: { instagram?: string; youtube?: string; tiktok?: string; facebook?: string };
	delivery: { pickupEnabled: boolean; shippingEnabled: boolean; shippingFeeMinor: number; pickupNote?: string };
	legal: { termsVersion: string; privacyVersion: string };
	faqs: { question: string; answer: string }[];
	serverTime: string;
}

export interface HomeContent {
	/** Signature treatments are opt-in per organization; `simple` is the default. */
	heroStyle?: 'garage' | 'simple';
	processStyle?: 'pistons' | 'list';
	heroTitle: string;
	heroLead: string;
	heroImage: string | null;
	heroImageAlt?: string;
	servicesTitle?: string;
	services: { title: string; body: string }[];
	processTitle?: string;
	process: { title: string; body: string }[];
	ctaTitle: string;
	ctaBody: string;
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
	mainPrize: string | null;
	prizeCount: number;
}

export interface CampaignDetail {
	slug: string;
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
	modality: string | null;
	authority: string | null;
	seo: { title?: string; description?: string; image?: string };
	acceptingParticipations: boolean;
	compliance: { allowed: boolean; approvals: { kind: 'legal' | 'psp'; status: string; authority: string | null; reference: string | null; decidedAt: string | null }[] };
	rules: { version: number; status: string; body: string; eligibility: { minAge: number; residency: string; excluded: string[] }; contentHash: string | null; lockedAt: string | null } | null;
	qualifyingVariants: string[];
	prizes: { position: number; kind: string; title: string; description: string | null; declaredValueMinor: number; currency: string; quantity: number; conditions: string | null; imageUrl: string | null }[];
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
	totals: { eligibleEntries: number; participants: number; voidedEntries: number };
	ruleVersions: { version: number; status: string; lockedAt: string | null; contentHash: string | null; announcement: string | null }[];
	manifest: { sha256: string; eligibleCount: number; voidCount: number; closedAt: string; publishedAt: string } | null;
	timeline: { kind: string; title: string; detail: string | null; evidenceUrl: string | null; occurredAt: string }[];
	awards: { prize: string; slot: number; role: string; status: string; entryNumber: number | null; fulfillment: { status: string; deliveredAt: string | null; evidenceUrl: string | null } | null }[];
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
	errors?: { code: string; variantId?: string }[];
	currency?: string;
	lines?: { variantId: string; name: string; kind: 'digital' | 'physical'; quantity: number; unitPriceMinor: number; lineTotalMinor: number }[];
	subtotalMinor?: number;
	deliveryFeeMinor?: number;
	totalMinor?: number;
	requiresDelivery?: boolean;
	delivery?: SiteData['delivery'];
}

export interface ApiErrorBody {
	error: { code: string; message: string; details?: unknown };
}
