import { expect, test } from '@playwright/test';

// Feedback 2026-10-28 S10: chances are a promotional benefit granted with a
// purchase, never sold, so no legal text may describe them as bought.
test('legal texts never describe chances as bought', async ({ page }) => {
	for (const path of ['/legales/terminos', '/legales/privacidad']) {
		await page.goto(path);
		await expect(page.locator('main')).not.toContainText(/chances? que compr/i);
	}
	await page.goto('/legales/terminos');
	await expect(page.locator('main')).toContainText('no se venden por separado');
	await expect(page.locator('main')).toContainText('incluyen los impuestos');
});

// S12: an organization without a WhatsApp number still gets the withdrawal page, with its other channels.
test('the withdrawal page without a WhatsApp number lists the contact channels', async ({ page }) => {
	await page.goto('http://pista.localhost:5173/arrepentimiento');
	await expect(page.getByRole('heading', { name: 'Canales de contacto' })).toBeVisible();
	await expect(page.locator('a[href^="https://wa.me"]')).toHaveCount(0);
	await expect(page.locator('footer').getByRole('link', { name: 'Botón de arrepentimiento' })).toHaveCount(1);
});
