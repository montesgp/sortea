import { expect, test, type Page } from '@playwright/test';

// Back office polish 2026-11-06 (S5): the audit log is paginated on the server and
// filtered by action, origin, object id and local days, all kept in the URL.
const password = process.env.E2E_ADMIN_PASSWORD;
test.skip(!password, 'Set E2E_ADMIN_PASSWORD to the password printed by the seed');

async function signIn(page: Page, email: string) {
	await page.goto('/admin/login?next=/admin/auditoria');
	await page.getByLabel('Email').fill(email);
	await page.getByLabel('Contraseña').fill(password!);
	await page.getByRole('button', { name: 'Ingresar' }).click();
}

const total = async (page: Page) => Number((await page.getByText(/^\d+ eventos\.$/).textContent())!.split(' ')[0]);

test('the owner pages through the audit log and filters it', async ({ page }) => {
	await signIn(page, 'owner@tallerdemo.local');
	await page.waitForURL((url) => url.pathname === '/admin/auditoria');
	await expect(page.getByRole('heading', { name: 'Auditoría' })).toBeVisible();
	const all = await total(page);
	const rows = page.locator('tbody tr');
	expect(await rows.count()).toBe(Math.min(all, 50));

	if (all > 50) {
		await page.getByRole('link', { name: 'Siguiente' }).click();
		await expect(page).toHaveURL(/page=2/);
		await expect(page.getByText(`Página 2 de ${Math.ceil(all / 50)}`)).toBeVisible();
		await page.getByRole('link', { name: 'Anterior' }).click();
		await expect(page).toHaveURL(/page=1/);
	}

	// Signing in wrote nothing personal, but the seed and the login always leave some action to pick.
	const action = (await page.locator('#action option').nth(1).getAttribute('value'))!;
	await page.getByLabel('Acción').selectOption(action);
	await page.getByRole('button', { name: 'Filtrar' }).click();
	await expect(page).toHaveURL(new RegExp(`action=${encodeURIComponent(action).replace(/\./g, '\\.')}`));
	const filtered = await total(page);
	expect(filtered).toBeGreaterThan(0);
	expect(filtered).toBeLessThanOrEqual(all);
	for (const code of await page.locator('tbody td code').allTextContents()) expect(code).toBe(action);
	await expect(page.getByLabel('Acción')).toHaveValue(action);

	await page.getByLabel('Desde').fill('2099-01-01');
	await page.getByRole('button', { name: 'Filtrar' }).click();
	await expect(page.getByText('0 eventos.')).toBeVisible();
	await expect(page.getByText('No hay eventos con esos filtros.')).toBeVisible();

	await page.goto('/admin/auditoria?from=2026-11-02&to=2026-11-01');
	await expect(page.getByRole('alert')).toHaveText('La fecha "Desde" no puede ser posterior a la fecha "Hasta"');

	await page.getByRole('link', { name: 'Limpiar' }).click();
	await expect(page).toHaveURL(/\/admin\/auditoria$/);
	expect(await total(page)).toBeGreaterThanOrEqual(all);
});

test('an operator without audit.view still cannot open the audit log', async ({ page }) => {
	await signIn(page, 'operador@tallerdemo.local');
	await page.waitForURL((url) => url.pathname === '/admin/auditoria');
	const response = await page.goto('/admin/auditoria');
	expect(response?.status()).toBe(403);
});
