import { expect, test, type Page } from '@playwright/test';
import { campaignOpen, expectDeclaredCampaignState } from './campaign-state';

// Owner feedback 2026-10-16 (S8, S4): when a campaign exists it comes first.
// On the home it sits right after the hero with all its draw data; on the shop
// it is the hook above the products. The chances example only shows while a
// campaign accepts participations: hidden with the seeded campaign (approvals
// pending), shown when it is open (approvals recorded, or the local demo mode,
// ADR 0013). Which state applies is declared by the runner (E2E_CAMPAIGN_OPEN,
// see campaign-state.ts), never read from the page. The wording is covered by
// src/lib/chances.test.ts and the counts by apps/api/test/chances.test.ts.

/** The first-level headings of the page sections, in document order. */
function sectionHeadings(page: Page) {
	return page.locator('main > *').evaluateAll((nodes) => nodes.map((node) => node.querySelector('h1, h2')?.textContent?.trim() ?? ''));
}

async function expectDrawData(campaign: ReturnType<Page['locator']>) {
	await expect(campaign.getByText('Apertura', { exact: true })).toBeVisible();
	await expect(campaign.getByText('Cierre', { exact: true })).toBeVisible();
	// The countdown, or its message once the seeded opening date has passed.
	await expect(campaign.getByRole('timer').or(campaign.getByText('La apertura es inminente'))).toBeVisible();
	const prizes = campaign.getByRole('list', { name: 'Premios' });
	await expect(prizes.getByRole('listitem').first()).toBeVisible();
	await expect(campaign.getByRole('link', { name: 'Transparencia y bases' })).toBeVisible();
}

for (const [width, height] of [
	[1366, 900],
	[390, 844]
]) {
	test(`home: the campaign comes right after the hero with its draw data at ${width}px`, async ({ page }) => {
		await page.setViewportSize({ width, height });
		await page.goto('/');
		const campaign = page.locator('main > section.hero + section');
		await expect(campaign.getByRole('link', { name: 'Ver la campaña' })).toBeVisible();
		await expectDrawData(campaign);

		const title = (await campaign.getByRole('heading', { level: 2 }).first().textContent())!.trim();
		const headings = await sectionHeadings(page);
		expect(headings.indexOf(title)).toBe(1);
		for (const later of ['De la tienda', 'Preguntas frecuentes']) expect(headings.indexOf(later)).toBeGreaterThan(1);
		await expectDeclaredCampaignState(campaign);
		await expect(page.getByText(/^Ejemplo:/)).toHaveCount(campaignOpen ? 1 : 0);
	});

	test(`shop: the campaign is the hook above the products at ${width}px`, async ({ page }) => {
		await page.setViewportSize({ width, height });
		await page.goto('/tienda');
		const campaign = page.locator('main > section').first();
		await expect(campaign.getByRole('heading', { level: 1 })).toBeVisible();
		await expectDrawData(campaign);
		await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);

		const firstProduct = page.getByRole('article').first();
		const [band, product] = [(await campaign.boundingBox())!, (await firstProduct.boundingBox())!];
		expect(band.y + band.height).toBeLessThanOrEqual(product.y);

		await campaign.getByRole('link', { name: 'Ver los productos' }).click();
		await expect(page).toHaveURL(/#productos$/);
		await expect(page.getByRole('heading', { name: 'Productos', level: 2 })).toBeInViewport();
		await expectDeclaredCampaignState(campaign);
		await expect(page.getByText(/^Ejemplo:/)).toHaveCount(campaignOpen ? 1 : 0);
	});
}
