import { expect, test, type Page } from '@playwright/test';
import { campaignOpen } from './campaign-state';
import { declareAdultIfAsked } from './checkout-consents';

// Owner feedback 2026-11-11b: "Copiar resumen" on the paid result (S1) and each order's coupons in
// Consultar (S9). The summary text itself is covered by src/lib/order-summary.test.ts.

async function buyAndPay(page: Page) {
	const email = `e2e-summary-${Date.now()}@example.com`;
	await page.goto('/tienda');
	await page.getByRole('article').filter({ hasText: 'Manual técnico' }).getByRole('button', { name: 'Agregar al carrito' }).click();
	await page.getByRole('link', { name: 'Continuar con la compra' }).click();
	await page.getByLabel('Nombre', { exact: true }).fill('Prueba');
	await page.getByLabel('Apellido').fill('Resumen');
	await page.getByLabel('Número').fill(String(20_000_000 + Math.floor(Math.random() * 9_000_000)));
	await page.getByLabel('Email', { exact: true }).fill(email);
	await page.getByLabel('Repetí el email').fill(email);
	await page.getByLabel('Teléfono', { exact: true }).fill('+54 9 11 2345-6789');
	await page.getByLabel('Provincia', { exact: true }).selectOption('Buenos Aires');
	await page.getByLabel('Ciudad', { exact: true }).fill('Pergamino');
	await page.getByLabel(/Acepto los/).check();
	await page.getByLabel(/Leí la/).check();
	await declareAdultIfAsked(page);
	await page.getByRole('button', { name: /Ir a pagar/ }).click();
	await page.getByRole('button', { name: 'Aprobar pago' }).click();
	await expect(page.getByRole('heading', { name: /compra está confirmada/ })).toBeVisible({ timeout: 20_000 });
	const reference = (await page.locator('.code').first().textContent())!.trim();
	const accessCode = (await page.locator('.code').nth(1).textContent())!.trim();
	return { reference, accessCode };
}

test('"Copiar resumen" copies the purchase and says "Copiado"', async ({ page, context }) => {
	await context.grantPermissions(['clipboard-read', 'clipboard-write']);
	const { reference, accessCode } = await buyAndPay(page);
	await page.getByRole('button', { name: 'Copiar resumen' }).click();
	await expect(page.getByRole('status').filter({ hasText: 'Copiado' })).toBeVisible();
	const copied = await page.evaluate(() => navigator.clipboard.readText());
	expect(copied).toContain(`Compra ${reference}`);
	expect(copied).toMatch(/Manual técnico.* × 1/);
	expect(copied).toMatch(/Total: \$/);
	expect(copied).not.toContain(accessCode);
	if (campaignOpen) expect(copied).toMatch(/Tus chances para .+ \(\d+\): N\.º \d+/);

	// The same purchase in Consultar lists its own coupons (S9).
	await page.goto('/consulta');
	await page.getByLabel('Comprobante').fill(reference);
	await page.getByLabel('Código de acceso').fill(accessCode);
	await page.getByRole('button', { name: 'Ver esta compra' }).click();
	await expect(page.getByText(reference)).toBeVisible();
	if (campaignOpen) await expect(page.locator('.order-coupons')).toContainText(/Tus chances para .+ \(\d+\): N\.º \d+/);
});

test('without a clipboard the summary is shown as text to select', async ({ page }) => {
	await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true }));
	const { reference } = await buyAndPay(page);
	await page.getByRole('button', { name: 'Copiar resumen' }).click();
	const area = page.getByLabel('No pudimos copiarlo solo: seleccioná el texto y copialo.');
	await expect(area).toBeFocused();
	await expect(area).toHaveValue(new RegExp(`Compra ${reference}`));
});
