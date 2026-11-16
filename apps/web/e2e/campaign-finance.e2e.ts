import { expect, test, type Page } from '@playwright/test';
import { signOut } from './admin-account';

// odd/tasks/campaign-finance.md T3: the overview per campaign (S1), its expenses (S2) and the
// balance (S3, S5) on the seeded Taller Demo.
const password = process.env.E2E_ADMIN_PASSWORD;
test.skip(!password, 'Set E2E_ADMIN_PASSWORD to the password printed by the seed');

const campaign = 'Honda Tornado 300 0 km';

async function signIn(page: Page, email: string) {
	await page.goto('/admin/login');
	await page.getByLabel('Email').fill(email);
	await page.getByLabel('Contraseña').fill(password!);
	await page.getByRole('button', { name: 'Ingresar' }).click();
	await expect(page.getByRole('heading', { name: 'Resumen' })).toBeVisible();
}

async function chooseCampaign(page: Page) {
	await page.getByLabel('Ver el resumen de').selectOption({ label: campaign });
	await page.getByRole('button', { name: 'Ver', exact: true }).click();
	await expect(page).toHaveURL(/\?campana=[0-9a-f-]{36}$/);
	await expect(page.getByTestId('overview-scope')).toContainText(`Campaña: ${campaign}`);
}

test('finance adds an expense to a campaign, sees it in the balance and deletes it', async ({ page }) => {
	const detail = `Prueba e2e ${Date.now()}`;
	await signIn(page, 'finanzas@tallerdemo.local');
	await expect(page.getByTestId('overview-scope')).toContainText('General: toda la organización');
	await chooseCampaign(page);
	const scoped = page.url();

	// The scope survives a reload.
	await page.reload();
	await expect(page.getByTestId('overview-scope')).toContainText(`Campaña: ${campaign}`);
	await expect(page.getByRole('heading', { name: 'Balance de la campaña' })).toBeVisible();

	const expenses = page.getByRole('region', { name: 'Gastos' });
	await expenses.getByLabel('Categoría').selectOption({ label: 'Combustible y traslados' });
	await expenses.getByLabel('Detalle').fill(detail);
	await expenses.getByLabel('Monto en pesos').fill('12.50');
	await expenses.getByRole('button', { name: 'Cargar gasto' }).click();
	await expect(expenses.getByRole('alert')).toHaveText('Escribí el monto en pesos, por ejemplo 12.500 o 12500,50');
	await expect(expenses.getByLabel('Detalle')).toHaveValue(detail);

	await expenses.getByLabel('Monto en pesos').fill('12.345,67');
	await expenses.getByRole('button', { name: 'Cargar gasto' }).click();
	await expect(expenses.getByRole('status')).toHaveText('Gasto cargado');
	const row = expenses.getByRole('row').filter({ hasText: detail });
	await expect(row).toContainText('Combustible y traslados');
	await expect(row).toContainText('$ 12.345,67');
	await expect(page.getByRole('region', { name: 'Balance de la campaña' })).toContainText('Combustible y traslados');

	await row.getByRole('link', { name: `Eliminar ${detail}` }).click();
	await expect(expenses.getByText(`¿Eliminar el gasto «${detail}» de $ 12.345,67?`)).toBeVisible();
	await expenses.getByRole('button', { name: 'Eliminar gasto' }).click();
	await expect(expenses.getByRole('status')).toHaveText('Gasto eliminado');
	await expect(expenses.getByRole('row').filter({ hasText: detail })).toHaveCount(0);

	// Back to the general view and forward again keep the scope in the URL.
	await page.goto('/admin');
	await expect(page.getByTestId('overview-scope')).toContainText('General: toda la organización');
	await page.goto(scoped);
	await page.goBack();
	await expect(page.getByTestId('overview-scope')).toContainText('General: toda la organización');
});

test('an operator sees the expenses and the balance without the form', async ({ page }) => {
	await signIn(page, 'operador@tallerdemo.local');
	await chooseCampaign(page);
	await expect(page.getByRole('heading', { name: 'Balance de la campaña' })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Gastos', exact: true })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Cargar gasto' })).toHaveCount(0);
	await expect(page.getByLabel('Monto en pesos')).toHaveCount(0);
	await signOut(page);
});
