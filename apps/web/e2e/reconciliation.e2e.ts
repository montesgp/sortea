import { expect, test, type Page } from '@playwright/test';
import { signOut } from './admin-account';

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
	await signIn(page, 'finanzas@tallerdemo.local');
	await page.getByRole('link', { name: 'Conciliación' }).click();
	await expect(page.getByRole('heading', { name: 'Conciliación' })).toBeVisible();
	await expect(page.getByText('Disponible y retiros')).toBeVisible();

	await page.getByRole('button', { name: 'Conciliar ahora' }).click();
	await expect(page.getByRole('status')).toContainText('Conciliación completa');
	await expect(page.getByRole('table').last()).toContainText('Completa');
});

test('a settlement report in the wrong format is refused with a clear message', async ({ page }) => {
	await signIn(page, 'finanzas@tallerdemo.local');
	await page.goto('/admin/conciliacion');
	await page.getByLabel('Archivo CSV').setInputFiles({ name: 'ventas.csv', mimeType: 'text/csv', buffer: Buffer.from('fecha,importe\n2026-10-01,100\n') });
	await page.getByRole('button', { name: 'Subir y comparar' }).click();
	await expect(page.getByRole('alert')).toContainText('No parece el reporte de liquidaciones de Mercado Pago');
});

test('the owner consults reconciliation but cannot run it; operators do not see it', async ({ page }) => {
	await signIn(page, 'owner@tallerdemo.local');
	await page.getByRole('link', { name: 'Conciliación' }).click();
	await expect(page.getByText('Bruto aprobado')).toBeVisible();
	await expect(page.getByRole('button', { name: 'Conciliar ahora' })).toHaveCount(0);

	await signOut(page);
	// Navigating before the logout lands aborts it, and the login page then redirects to the panel.
	await expect(page.getByRole('button', { name: 'Ingresar' })).toBeVisible();
	await signIn(page, 'operador@tallerdemo.local');
	await expect(page.getByRole('link', { name: 'Conciliación' })).toHaveCount(0);
	const response = await page.goto('/admin/conciliacion');
	expect(response?.status()).toBe(403);
});

test('finance narrows the money summary to one campaign and covers it whole', async ({ page }) => {
	await signIn(page, 'finanzas@tallerdemo.local');
	await page.goto('/admin/conciliacion');
	await expect(page.getByLabel('Campaña')).toHaveValue('');
	await expect(page.getByText('Todos los pagos aprobados.')).toBeVisible();

	await page.getByLabel('Campaña').selectOption({ label: 'Honda Tornado 300 0 km' });
	await page.getByRole('button', { name: 'Ver período' }).click();
	await expect(page).toHaveURL(/campana=[0-9a-f-]{36}/);
	await expect(page.getByLabel('Campaña')).toHaveValue(/^[0-9a-f-]{36}$/);
	await expect(page.getByText('Pagos aprobados de las órdenes de la campaña Honda Tornado 300 0 km.')).toBeVisible();

	// From the opening day to the day its last order can still be paid (closes 28/11 20:00, plus the time to pay).
	await page.getByRole('link', { name: 'Toda la campaña' }).click();
	await expect(page).toHaveURL(/desde=2026-10-20/);
	await expect(page).toHaveURL(/hasta=2026-11-28/);
	await expect(page).toHaveURL(/campana=[0-9a-f-]{36}/);
	await expect(page.getByLabel('Desde')).toHaveValue('20/10/2026');
	await expect(page.getByLabel('Hasta')).toHaveValue('28/11/2026');
	await expect(page.getByText('Pagos aprobados de las órdenes de la campaña Honda Tornado 300 0 km en el período elegido.')).toBeVisible();

	await page.getByLabel('Campaña').selectOption({ label: 'Todas' });
	await page.getByRole('button', { name: 'Ver período' }).click();
	await expect(page).not.toHaveURL(/campana=[0-9a-f]/);
	await expect(page.getByLabel('Campaña')).toHaveValue('');
	await expect(page.getByText('Pagos aprobados en el período elegido.')).toBeVisible();
});

test('a campaign that is not the organization’s is reported and the full summary shows', async ({ page }) => {
	await signIn(page, 'finanzas@tallerdemo.local');
	await page.goto('/admin/conciliacion?campana=00000000-0000-4000-8000-000000000000');
	await expect(page.getByRole('alert')).toContainText('No encontramos esa campaña en esta organización');
	await expect(page.getByLabel('Campaña')).toHaveValue('');
	await expect(page.getByText('Bruto aprobado')).toBeVisible();
});
