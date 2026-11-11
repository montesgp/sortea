import { expect, test, type Page } from '@playwright/test';

// Seeded local accounts share one password (SEED_ADMIN_PASSWORD in .env).
const password = process.env.E2E_ADMIN_PASSWORD;
test.skip(!password, 'Set E2E_ADMIN_PASSWORD to the password printed by the seed');

async function signIn(page: Page, email: string) {
	await page.goto('/admin/login');
	await page.getByLabel('Email').fill(email);
	await page.getByLabel('Contraseña').fill(password!);
	await page.getByRole('button', { name: 'Ingresar' }).click();
	await expect(page.getByRole('heading', { name: 'Resumen' })).toBeVisible();
}

// S5 (owner feedback 2026-11-10): a campaign is created from the admin as a draft, possibly without dates.
test('the owner creates a draft campaign without dates, which cannot be published until it has them', async ({ page }) => {
	const slug = `e2e-campana-${Date.now()}`;
	const title = `Moto de prueba ${slug}`;
	await signIn(page, 'owner@tallerdemo.local');
	await page.getByRole('link', { name: 'Campañas' }).click();
	await page.getByRole('link', { name: 'Nueva campaña' }).click();
	await expect(page.getByRole('heading', { name: 'Nueva campaña' })).toBeVisible();

	await page.getByLabel('Título', { exact: true }).fill(title);
	await page.getByLabel('Dirección pública').fill(slug);
	await page.getByLabel('Resumen').fill('Campaña de prueba automática, sin fechas todavía.');
	await page.getByLabel('Texto inicial de las bases').fill('# Bases\n\nTexto inicial de prueba de las bases y condiciones.');
	await page.getByRole('button', { name: 'Crear borrador' }).click();

	await expect(page.getByRole('heading', { name: title })).toBeVisible();
	await expect(page.getByText('Borrador · fechas a definir')).toBeVisible();
	await expect(page.getByText(/Las fechas están a definir/)).toBeVisible();
	await expect(page.getByText(/Para abrir participaciones falta autorización legal y aprobación del medio de pago/)).toBeVisible();
	await expect(page.getByRole('button', { name: 'Enviar a revisión' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Abrir participaciones' })).toHaveCount(0);

	await page.getByRole('link', { name: 'Volver a campañas' }).click();
	const row = page.getByRole('row').filter({ hasText: title });
	await expect(row.getByText('Borrador · fechas a definir')).toBeVisible();
	await expect(row.getByText('A definir', { exact: true })).toHaveCount(2);
});

test('the form keeps what was typed and says which field is wrong', async ({ page }) => {
	await signIn(page, 'owner@tallerdemo.local');
	await page.goto('/admin/campanas/nueva');
	await page.getByLabel('Título', { exact: true }).fill('Campaña con fechas al revés');
	await page.getByLabel('Dirección pública').fill(`e2e-al-reves-${Date.now()}`);
	await page.getByLabel('Resumen').fill('Campaña de prueba con el cierre antes de la apertura.');
	await page.getByLabel(/^Apertura/).fill('2027-03-10T10:00');
	await page.getByLabel(/^Cierre/).fill('2027-03-01T10:00');
	await page.getByLabel('Texto inicial de las bases').fill('Texto inicial de prueba de las bases y condiciones.');
	await page.getByRole('button', { name: 'Crear borrador' }).click();

	await expect(page.getByRole('alert')).toContainText('Revisá los campos marcados');
	await expect(page.getByText('El cierre tiene que ser posterior a la apertura')).toBeVisible();
	await expect(page.getByLabel(/^Cierre/)).toHaveAttribute('aria-invalid', 'true');
	await expect(page.getByLabel('Título', { exact: true })).toHaveValue('Campaña con fechas al revés');
});

test('an operator cannot create campaigns', async ({ page }) => {
	await signIn(page, 'operador@tallerdemo.local');
	await page.getByRole('link', { name: 'Campañas' }).click();
	await expect(page.getByRole('link', { name: 'Nueva campaña' })).toHaveCount(0);
	const response = await page.goto('/admin/campanas/nueva');
	expect(response?.status()).toBe(403);
});
