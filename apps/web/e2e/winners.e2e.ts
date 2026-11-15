import { expect, test } from '@playwright/test';

// Feedback 2026-10-28 S5 and 2026-11-14 S3: a public winners table once results are
// published, naming every winner with name and city; checkout asks nothing about it.
// Seed data never carries approvals, so no local campaign reaches published results;
// the table is covered by apps/api/test/winners.test.ts. Here: what the local stack shows before.
const slug = 'tornado-300';

test('the campaign page has no winners table before results are published', async ({ page }) => {
	await page.goto(`/sorteos/${slug}`);
	const prizes = page.getByRole('region', { name: 'Premios', exact: true });
	await expect(prizes).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Ganadores', exact: true })).toHaveCount(0);
	await expect(page.getByRole('region', { name: 'Ganadores', exact: true })).toHaveCount(0);
	// Scoped to the prizes: a campaign's bases published before 2026-11-14 are immutable and may still quote the old label.
	await expect(prizes.getByText('reservó el derecho de no mostrar su identidad')).toHaveCount(0);
});

test('the checkout keeps its required consents and asks no winner publicity choice', async ({ page }) => {
	await page.goto('/tienda', { waitUntil: 'networkidle' });
	await page.getByRole('article').filter({ hasText: 'Manual técnico' }).getByRole('button', { name: 'Agregar al carrito' }).click();
	await expect(page).toHaveURL(/\/carrito$/);
	// The cart says whether its lines give chances (only while a campaign accepts participations).
	const givesChances = (await page.locator('.line-chances').count()) > 0;
	await page.goto('/checkout', { waitUntil: 'networkidle' });
	await expect(page.locator('input[name="terms"]')).not.toBeChecked();
	await expect(page.locator('input[name="privacy"]')).not.toBeChecked();
	await expect(page.locator('input[name="winnerPublicity"]')).toHaveCount(0);
	const notice = page.getByText('Si ganás, publicamos tu nombre, tu apellido y tu ciudad; nunca tu documento, tu domicilio, tu email ni tu teléfono.');
	// The notice comes with the chances: while the demo campaign is not open locally this cart gives none.
	await expect(notice).toHaveCount(givesChances ? 1 : 0);
});
