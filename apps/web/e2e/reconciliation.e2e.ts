import { expect, test, type Page } from '@playwright/test';

// Seeded local accounts share one password, printed by `pnpm db:seed`.
const password = process.env.E2E_ADMIN_PASSWORD;
test.skip(!password, 'Set E2E_ADMIN_PASSWORD to the password printed by the seed');

async function signIn(page: Page, email: string) {
	await page.goto('/admin/login');
	await page.getByLabel('Email').fill(email);
	await page.getByLabel('Contraseña').fill(password!);
	await page.getByRole('button', { name: 'Ingresar' }).click();
	await expect(page.getByRole('heading', { name: 'Resumen' })).toBeVisible();
}

test('finance reconciles on demand and sees money as Mercado Pago reports it (FR-PAY-05/06)', async ({ page }) => {
	await signIn(page, 'finanzas@motogarage.local');
	await page.getByRole('link', { name: 'Conciliación' }).click();
	await expect(page.getByRole('heading', { name: 'Conciliación' })).toBeVisible();
	await expect(page.getByText('Disponible y retiros')).toBeVisible();

	await page.getByRole('button', { name: 'Conciliar ahora' }).click();
	await expect(page.getByRole('status')).toContainText('Conciliación completa');
	await expect(page.getByRole('table').last()).toContainText('Completa');
});

test('a settlement report in the wrong format is refused with a clear message', async ({ page }) => {
	await signIn(page, 'finanzas@motogarage.local');
	await page.goto('/admin/conciliacion');
	await page.getByLabel('Archivo CSV').setInputFiles({ name: 'ventas.csv', mimeType: 'text/csv', buffer: Buffer.from('fecha,importe\n2026-10-01,100\n') });
	await page.getByRole('button', { name: 'Subir y comparar' }).click();
	await expect(page.getByRole('alert')).toContainText('No parece el reporte de liquidaciones de Mercado Pago');
});

test('the owner consults reconciliation but cannot run it; operators do not see it', async ({ page }) => {
	await signIn(page, 'owner@motogarage.local');
	await page.getByRole('link', { name: 'Conciliación' }).click();
	await expect(page.getByText('Bruto aprobado')).toBeVisible();
	await expect(page.getByRole('button', { name: 'Conciliar ahora' })).toHaveCount(0);

	await page.getByRole('button', { name: 'Cerrar sesión' }).click();
	await signIn(page, 'operador@motogarage.local');
	await expect(page.getByRole('link', { name: 'Conciliación' })).toHaveCount(0);
	const response = await page.goto('/admin/conciliacion');
	expect(response?.status()).toBe(403);
});
