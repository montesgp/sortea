/**
 * The photo a shared campaign link shows (owner feedback 2026-11-15c S1): the image set for
 * sharing in the campaign's SEO, then the main prize photo, then the first photo of its gallery,
 * then the hero image; an empty value counts as none. Previews need an absolute URL; library images and pack files are site paths.
 */
export interface ShareableCampaign {
	seo: { image?: string };
	prizes: readonly { imageUrl: string | null; gallery?: readonly { kind: string; url: string }[] }[];
	media: readonly { kind: string; role: string; url: string }[];
}

export function campaignShareImage(campaign: ShareableCampaign, origin: string): string | null {
	const main = campaign.prizes[0];
	const image =
		campaign.seo.image ||
		main?.imageUrl ||
		main?.gallery?.find((item) => item.kind === 'image' && item.url)?.url ||
		campaign.media.find((item) => item.role === 'hero' && item.kind === 'image' && item.url)?.url ||
		null;
	return image ? new URL(image, origin).href : null;
}
