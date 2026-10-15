import { expect, test, type Page } from '@playwright/test';

// Seeded local accounts share one password (SEED_ADMIN_PASSWORD in .env).
const password = process.env.E2E_ADMIN_PASSWORD;
test.skip(!password, 'Set E2E_ADMIN_PASSWORD to the password printed by the seed');

async function openAwards(page: Page, email: string) {
	await page.goto('/admin/login');
	await page.getByLabel('Email').fill(email);
	await page.getByLabel('Contraseña').fill(password!);
	await page.getByRole('button', { name: 'Ingresar' }).click();
	await expect(page.getByRole('heading', { name: 'Resumen' })).toBeVisible();
	await page.getByRole('link', { name: 'Campañas' }).click();
	await page.getByRole('link', { name: /Honda Tornado/ }).click();
	await expect(page.getByRole('heading', { name: /Honda Tornado/ })).toBeVisible();
	await page.goto(`${page.url()}/premios`);
	await expect(page.getByRole('heading', { name: 'Premios y entregas' })).toBeVisible();
}

// Seed data never carries approvals, so no local campaign can reach the awarding
// stage; recording, verification and delivery are covered by apps/api/test/awards.test.ts.
test('a campaign that is not awarding shows every prize unit but no way to record results', async ({ page }) => {
	await openAwards(page, 'operador@motogarage.local');
	await expect(page.getByText('Las adjudicaciones se registran con la campaña en adjudicación')).toBeVisible();
	await expect(page.getByText('Unidad 1').first()).toBeVisible();
	await expect(page.getByText('Sin resultado').first()).toBeVisible();
	await expect(page.getByText('Cargar resultado')).toHaveCount(0);
	await expect(page.getByText('Los datos de contacto se muestran enmascarados para tu rol.')).toBeVisible();
});
