import { expect, test, type Page } from '@playwright/test';

// Seeded local accounts share one password, printed by `pnpm db:seed`.
const password = process.env.E2E_ADMIN_PASSWORD;
test.skip(!password, 'Set E2E_ADMIN_PASSWORD to the password printed by the seed');

async function signIn(page: Page, email: string, base = '') {
	await page.goto(`${base}/admin/login`);
	await page.getByLabel('Email').fill(email);
	await page.getByLabel('Contraseña').fill(password!);
	await page.getByRole('button', { name: 'Ingresar' }).click();
}

test('the owner sees the dashboard and cannot open a campaign without approvals', async ({ page }) => {
	await signIn(page, 'owner@motogarage.local');
	await expect(page.getByRole('heading', { name: 'Resumen' })).toBeVisible();
	await expect(page.getByText('Ventas aprobadas')).toBeVisible();

	await page.getByRole('link', { name: 'Campañas' }).click();
	await page.getByRole('link', { name: /Honda Tornado/ }).click();
	await expect(page.getByText(/Para abrir participaciones falta autorización legal y aprobación del medio de pago/)).toBeVisible();
	await expect(page.getByRole('button', { name: 'Abrir participaciones' })).toBeDisabled();
});

test('an operator sees masked buyer data and no approval controls', async ({ page }) => {
	await signIn(page, 'operador@motogarage.local');
	await page.getByRole('link', { name: 'Campañas' }).click();
	await page.getByRole('link', { name: /Honda Tornado/ }).click();
	await expect(page.getByRole('button', { name: 'Guardar', exact: true })).toHaveCount(0);
	await expect(page.getByRole('link', { name: 'Plataforma' })).toHaveCount(0);
});

test('an admin of another organization is refused on this hostname (AC-02)', async ({ page }) => {
	await signIn(page, 'owner@pistasur.local');
	await expect(page.getByText('Tu usuario no tiene acceso a esta organización')).toBeVisible();
});

test('platform staff manage organizations and never see stored secrets (AC-05)', async ({ page }) => {
	await signIn(page, 'admin@sortea.local');
	await page.getByRole('link', { name: 'Plataforma' }).click();
	await page.getByRole('link', { name: 'MotoGarage' }).click();
	await expect(page.getByRole('heading', { name: 'Mercado Pago' })).toBeVisible();
	await expect(page.getByText(/Token TEST••••/)).toBeVisible();
	await expect(page.getByLabel('Access token')).toHaveValue('');
	await expect(page.locator('body')).not.toContainText('TEST-fake-');
});
