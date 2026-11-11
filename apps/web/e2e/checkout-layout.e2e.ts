import { expect, test, type Page } from '@playwright/test';

// Feedback 2026-11-06: document type, number and phone share one row on wide
// screens; the cart says what the subtotal leaves out instead of a vague note.

async function addToCart(page: Page, product: string) {
	await page.goto('/tienda', { waitUntil: 'networkidle' });
	await page.getByRole('article').filter({ hasText: product }).first().getByRole('button', { name: 'Agregar al carrito' }).click();
	await expect(page).toHaveURL(/\/carrito$/);
}

test('document type, number and phone share one row on a wide screen and stack on a phone', async ({ page, context }) => {
	await context.clearCookies();
	await page.setViewportSize({ width: 1366, height: 900 });
	await addToCart(page, 'Manual técnico');
	await page.goto('/checkout', { waitUntil: 'networkidle' });
	const tops = async () =>
		Promise.all(['Documento', 'Número', 'Teléfono'].map(async (label) => (await page.getByLabel(label, { exact: true }).boundingBox())!.y));
	const wide = await tops();
	expect(Math.max(...wide) - Math.min(...wide)).toBeLessThanOrEqual(1);

	await page.setViewportSize({ width: 390, height: 900 });
	const narrow = await tops();
	expect(narrow[1]).toBeGreaterThan(narrow[0]);
	expect(narrow[2]).toBeGreaterThan(narrow[1]);
});

test('the cart note says the subtotal is the total, or that shipping is added next', async ({ page, context }) => {
	await context.clearCookies();
	await addToCart(page, 'Manual técnico');
	await expect(page.getByRole('status').filter({ hasText: 'Este es el total a pagar.' })).toBeVisible();
	await expect(page.getByText('El precio final se confirma al pagar.')).toHaveCount(0);

	await page.goto('/tienda', { waitUntil: 'networkidle' });
	await page.getByRole('article').filter({ hasText: 'Calcomanía' }).first().getByRole('button', { name: 'Agregar al carrito' }).click();
	await expect(page).toHaveURL(/\/carrito$/);
	await expect(page.getByRole('status').filter({ hasText: 'El costo de envío se suma en el próximo paso, según la entrega que elijas.' })).toBeVisible();
});
