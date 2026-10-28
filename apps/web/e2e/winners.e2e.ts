import { expect, test } from '@playwright/test';

// Feedback 2026-10-28 S5: a public winners table once results are published, naming
// only winners who consented at checkout. Seed data never carries approvals, so no
// local campaign reaches published results; the table and the consent rule are
// covered by apps/api/test/winners.test.ts. Here: what the local stack shows before.
const slug = 'tornado-300';

test('the campaign page has no winners table before results are published', async ({ page }) => {
	await page.goto(`/sorteos/${slug}`);
	await expect(page.getByRole('region', { name: 'Premios', exact: true })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Ganadores', exact: true })).toHaveCount(0);
	// The bases quote the withheld-identity text, so check that no winners section renders it.
	await expect(page.getByRole('region', { name: 'Ganadores', exact: true })).toHaveCount(0);
});

test('the checkout keeps its required consents and asks the publicity one only for purchases with chances', async ({ page }) => {
	await page.goto('/tienda', { waitUntil: 'networkidle' });
	await page.getByRole('article').filter({ hasText: 'Manual técnico' }).getByRole('button', { name: 'Agregar al carrito' }).click();
	await expect(page).toHaveURL(/\/carrito$/);
	// The cart says whether its lines give chances (only while a campaign accepts participations).
	const givesChances = (await page.locator('.line-chances').count()) > 0;
	await page.goto('/checkout', { waitUntil: 'networkidle' });
	await expect(page.locator('input[name="terms"]')).not.toBeChecked();
	await expect(page.locator('input[name="privacy"]')).not.toBeChecked();
	const publicity = page.locator('input[name="winnerPublicity"]');
	if (!givesChances) {
		// While the demo campaign is not open locally this cart gives no chances, so there is nothing to consent to.
		await expect(publicity).toHaveCount(0);
	} else {
		await expect(publicity).not.toBeChecked();
		await expect(page.getByText('si gano, acepto que se publiquen mi nombre, mi ciudad y la cantidad de chances que compré')).toBeVisible();
	}
});
