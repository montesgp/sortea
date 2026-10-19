import { expect, test, type Page } from '@playwright/test';

// Feedback 2026-10-19: from the checkout the buyer goes back to the cart and
// returns with what was typed; no newsletter consent for now; the header theme
// switch has room; the footer puts the tagline and the place on two lines.

async function toCheckout(page: Page) {
	await page.goto('/tienda', { waitUntil: 'networkidle' });
	await page.getByRole('article').filter({ hasText: 'Manual técnico' }).getByRole('button', { name: 'Agregar al carrito' }).click();
	await expect(page).toHaveURL(/\/carrito$/);
	await page.goto('/checkout', { waitUntil: 'networkidle' });
}

test('the buyer goes back to the cart and returns to a checkout that kept what was typed', async ({ page, context }) => {
	await context.clearCookies();
	await toCheckout(page);
	await page.getByLabel('Nombre', { exact: true }).fill('Ana');
	await page.getByLabel('Email', { exact: true }).fill('ana@example.com');
	await page.getByLabel('Provincia', { exact: true }).selectOption('Córdoba');
	await page.getByLabel('Ciudad', { exact: true }).fill('Río Cuarto');

	await page.getByRole('link', { name: 'Volver al carrito' }).click();
	await expect(page).toHaveURL(/\/carrito$/);
	await page.getByRole('link', { name: 'Continuar con la compra' }).click();
	await expect(page).toHaveURL(/\/checkout$/);
	await expect(page.getByLabel('Nombre', { exact: true })).toHaveValue('Ana');
	await expect(page.getByLabel('Email', { exact: true })).toHaveValue('ana@example.com');
	await expect(page.getByLabel('Provincia', { exact: true })).toHaveValue('Córdoba');
	await expect(page.getByLabel('Ciudad', { exact: true })).toHaveValue('Río Cuarto');

	// The browser's Back button works the same way.
	await page.getByRole('link', { name: 'Volver al carrito' }).click();
	await expect(page).toHaveURL(/\/carrito$/);
	await page.goBack();
	await expect(page.getByLabel('Nombre', { exact: true })).toHaveValue('Ana');
});

test('the checkout asks for no newsletter consent', async ({ page }) => {
	await toCheckout(page);
	await expect(page.getByText(/novedades por email/)).toHaveCount(0);
	await expect(page.getByRole('checkbox', { name: /novedades/ })).toHaveCount(0);
});

test('the theme switch keeps clear room from the cart', async ({ page }) => {
	await page.goto('/tienda', { waitUntil: 'networkidle' });
	const header = page.locator('header');
	const cart = (await header.getByRole('link', { name: /^Carrito/ }).boundingBox())!;
	const toggle = (await header.getByRole('button', { name: /Usar tema/ }).boundingBox())!;
	expect(toggle.x - (cart.x + cart.width)).toBeGreaterThanOrEqual(18);
});

test('the footer puts the tagline and the place on separate lines', async ({ page }) => {
	await page.goto('/', { waitUntil: 'networkidle' });
	const footer = page.getByRole('contentinfo');
	const tagline = footer.getByText('Motos, motores y restauraciones.', { exact: true });
	const place = footer.getByText('Arrecifes, Buenos Aires', { exact: true });
	await expect(tagline).toBeVisible();
	await expect(place).toBeVisible();
	expect((await place.boundingBox())!.y).toBeGreaterThan((await tagline.boundingBox())!.y);
});
