import { expect, type Locator } from '@playwright/test';

/**
 * Whether the seeded campaign accepts participations, as declared by whoever runs the suite,
 * never read from the page under test: E2E_CAMPAIGN_OPEN=1 when it is open (approvals
 * recorded, or the local demo mode, ADR 0013); unset for the seed's state (approvals pending).
 */
export const campaignOpen = process.env.E2E_CAMPAIGN_OPEN === '1';

/** The campaign shown in `scope` displays the declared state, so a wrong status fails here. */
export async function expectDeclaredCampaignState(scope: Locator) {
	await expect(
		scope.getByText('Participaciones abiertas', { exact: true }),
		campaignOpen ? 'E2E_CAMPAIGN_OPEN=1 declares the campaign open' : 'Without E2E_CAMPAIGN_OPEN=1 the campaign must not accept participations; set it when the local demo campaign is open'
	).toHaveCount(campaignOpen ? 1 : 0);
}
