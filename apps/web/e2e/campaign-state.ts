import { expect, type Locator, type Page } from '@playwright/test';

const declared = process.env.E2E_CAMPAIGN_OPEN?.trim().toLowerCase();
if (declared && !['1', 'true', '0', 'false'].includes(declared)) {
	throw new Error(`E2E_CAMPAIGN_OPEN must be 1 or true (open), 0 or false (not open), or unset; got "${process.env.E2E_CAMPAIGN_OPEN}"`);
}

/**
 * Whether the seeded campaign accepts participations, as declared by whoever runs the suite,
 * never read from the page under test: E2E_CAMPAIGN_OPEN=1 (or true) when it is open (approvals
 * recorded, or the local demo mode, ADR 0013); unset (or 0, false) for the seed's state.
 */
export const campaignOpen = declared === '1' || declared === 'true';

const OPEN = 'Participaciones abiertas';

/** The campaign band of the home or the shop (CampaignBand.svelte). */
export function campaignBand(page: Page): Locator {
	return page.locator('main section.band');
}

/**
 * The campaign shown in `scope` displays the declared state, so a wrong status fails here. The
 * band's chips must be visible first: a check on a missing band would prove nothing. Every chip
 * is checked, not only the first.
 */
export async function expectDeclaredCampaignState(scope: Locator) {
	const chips = scope.locator('.chips > .chip');
	await expect(chips.first(), 'the campaign band shows its status').toBeVisible();
	const open = chips.filter({ hasText: new RegExp(`^${OPEN}$`) });
	if (campaignOpen) await expect(open, 'E2E_CAMPAIGN_OPEN=1 declares the campaign open').toHaveCount(1);
	else await expect(open, 'Without E2E_CAMPAIGN_OPEN=1 the campaign must not accept participations; set it when the local demo campaign is open').toHaveCount(0);
}
