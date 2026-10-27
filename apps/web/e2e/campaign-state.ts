import { expect, type Locator, type Page } from '@playwright/test';

/**
 * Whether the seeded campaign accepts participations, as declared by whoever runs the suite,
 * never read from the page under test: E2E_CAMPAIGN_OPEN=1 when it is open (approvals
 * recorded, or the local demo mode, ADR 0013); unset for the seed's state (approvals pending).
 */
export const campaignOpen = process.env.E2E_CAMPAIGN_OPEN === '1';

/** The campaign band of the home or the shop (CampaignBand.svelte). */
export function campaignBand(page: Page): Locator {
	return page.locator('main section.band');
}

/**
 * The campaign shown in `scope` displays the declared state, so a wrong status fails here. The
 * band and its status chip must be visible first: a check on a missing band would prove nothing.
 */
export async function expectDeclaredCampaignState(scope: Locator) {
	const status = scope.locator('.chips > .chip').first();
	await expect(status, 'the campaign band shows its status').toBeVisible();
	if (campaignOpen) await expect(status, 'E2E_CAMPAIGN_OPEN=1 declares the campaign open').toHaveText('Participaciones abiertas');
	else await expect(status, 'Without E2E_CAMPAIGN_OPEN=1 the campaign must not accept participations; set it when the local demo campaign is open').not.toHaveText('Participaciones abiertas');
}
