import { expect, test, type Page } from '@playwright/test';
import { campaignOpen } from './campaign-state';
import { ADULT_DECLARATION } from './checkout-consents';

// Feedback 2026-10-28 S11: a purchase that gives chances asks the buyer to declare being 18 or
// older. Every seeded product gives chances while the demo campaign accepts participations, so
// the runner's E2E_CAMPAIGN_OPEN decides which case this stack shows (campaign-state.ts). The
// refusal and what is stored are covered by apps/api/test/adult-declaration.test.ts.

async function checkoutWithManual(page: Page) {
	await page.goto('/tienda', { waitUntil: 'networkidle' });
	await page.getByRole('article').filter({ hasText: 'Manual técnico' }).getByRole('button', { name: 'Agregar al carrito' }).click();
	await expect(page).toHaveURL(/\/carrito$/);
	await page.goto('/checkout', { waitUntil: 'networkidle' });
}

async function fillBuyer(page: Page) {
	const email = `e2e-adult-${Date.now()}@example.com`;
	await page.getByLabel('Nombre', { exact: true }).fill('Prueba');
	await page.getByLabel('Apellido').fill('Mayor');
	await page.getByLabel('Número', { exact: true }).fill(String(20_000_000 + Math.floor(Math.random() * 9_000_000)));
	await page.getByLabel('Email', { exact: true }).fill(email);
	await page.getByLabel('Repetí el email').fill(email);
	await page.getByLabel('Provincia', { exact: true }).selectOption('Buenos Aires');
	await page.getByLabel('Ciudad', { exact: true }).fill('Arrecifes');
}

test('a purchase with chances requires the adult declaration, with a Spanish error under it, asked again after an error', async ({ page }) => {
	test.skip(!campaignOpen, 'Only while the demo campaign accepts participations (E2E_CAMPAIGN_OPEN=1)');
	await checkoutWithManual(page);
	const declaration = page.getByLabel(ADULT_DECLARATION);
	await expect(declaration).not.toBeChecked();
	await expect(page.getByText('Solo las personas mayores de edad pueden recibir chances.')).toBeVisible();

	await fillBuyer(page);
	await page.getByLabel(/Acepto los/).check();
	await page.getByLabel(/Leí la/).check();
	await page.getByRole('button', { name: /Ir a pagar/ }).click();

	await expect(page.getByText('Revisá los datos marcados')).toBeVisible();
	await expect(page.locator('#adultDeclaration-error')).toHaveText('Para recibir chances tenés que declarar que sos mayor de 18 años');
	await expect(declaration).toHaveAttribute('aria-invalid', 'true');
	await expect(declaration).toHaveAccessibleDescription('Para recibir chances tenés que declarar que sos mayor de 18 años');
	// Like the terms and privacy, the declaration is asked again; what the buyer typed stays.
	await expect(declaration).not.toBeChecked();
	await expect(page.getByLabel(/Acepto los/)).not.toBeChecked();
	await expect(page.getByLabel('Apellido')).toHaveValue('Mayor');

	await page.getByLabel(/Acepto los/).check();
	await page.getByLabel(/Leí la/).check();
	await declaration.check();
	await expect(page.locator('#adultDeclaration-error')).toHaveCount(0);
	await page.getByRole('button', { name: /Ir a pagar/ }).click();
	await expect(page).toHaveURL(/\/pago-simulado/);
});

test('a purchase without chances never asks for the adult declaration', async ({ page }) => {
	test.skip(campaignOpen, 'Every seeded product gives chances while the demo campaign is open');
	await checkoutWithManual(page);
	await expect(page.getByLabel(ADULT_DECLARATION)).toHaveCount(0);
});
