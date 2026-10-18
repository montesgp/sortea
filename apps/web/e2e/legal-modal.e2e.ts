import { expect, test } from '@playwright/test';

// S4 (feedback 2026-10-18): legal links open the text in a modal over the page,
// so the buyer never leaves; Back closes it; the pages still work on their own.

test('the footer opens the terms in a modal over the page, and Back closes it', async ({ page }) => {
	await page.goto('/', { waitUntil: 'networkidle' });
	await page.getByRole('contentinfo').getByRole('link', { name: 'Términos y condiciones' }).click();
	const modal = page.getByRole('dialog', { name: 'Términos y condiciones de venta' });
	await expect(modal).toBeVisible();
	await expect(modal.getByRole('heading', { name: 'Arrepentimiento' })).toBeVisible();
	await expect(page).toHaveURL(/\/legales\/terminos$/);
	await page.goBack();
	await expect(modal).toBeHidden();
	await expect(page).toHaveURL(/\/$/);
});

test('in the checkout the privacy policy opens in place and the form keeps what was typed', async ({ page }) => {
	await page.goto('/tienda', { waitUntil: 'networkidle' });
	await page.getByRole('article').filter({ hasText: 'Manual técnico' }).getByRole('button', { name: 'Agregar al carrito' }).click();
	await expect(page).toHaveURL(/\/carrito$/);
	await page.goto('/checkout', { waitUntil: 'networkidle' });
	await page.getByLabel('Nombre', { exact: true }).fill('Ana');
	const privacy = page.getByRole('checkbox', { name: /Leí la política de privacidad/ });

	await page.getByRole('link', { name: 'política de privacidad' }).click();
	const modal = page.getByRole('dialog', { name: 'Privacidad y datos personales' });
	await expect(modal).toBeVisible();
	await modal.getByRole('button', { name: 'Entendido' }).click();
	await expect(modal).toBeHidden();
	await expect(page).toHaveURL(/\/checkout$/);
	await expect(page.getByLabel('Nombre', { exact: true })).toHaveValue('Ana');
	await expect(privacy).not.toBeChecked();

	await page.getByRole('link', { name: 'términos y condiciones de venta' }).click();
	await page.keyboard.press('Escape');
	await expect(page.getByRole('dialog')).toHaveCount(0);
	await expect(page).toHaveURL(/\/checkout$/);
});

test('a legal page still opens on its own', async ({ page }) => {
	await page.goto('/legales/privacidad');
	await expect(page.getByRole('heading', { level: 1, name: 'Privacidad y datos personales' })).toBeVisible();
});

test.describe('without JavaScript', () => {
	test.use({ javaScriptEnabled: false });

	test('a legal link is an ordinary link to the page', async ({ page }) => {
		await page.goto('/');
		await page.getByRole('contentinfo').getByRole('link', { name: 'Privacidad y datos personales' }).click();
		await expect(page).toHaveURL(/\/legales\/privacidad$/);
		await expect(page.getByRole('heading', { level: 1, name: 'Privacidad y datos personales' })).toBeVisible();
	});
});
