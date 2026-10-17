import { expect, test, type Page } from '@playwright/test';

// A platform admin connects an organization's Mercado Pago account in one step
// and disconnects it later (odd/tasks/mercadopago-connect.md, S1-S3). Locally
// the payment simulator stands in for Mercado Pago and accepts TEST- tokens.

const password = process.env.E2E_ADMIN_PASSWORD;
test.skip(!password, 'Set E2E_ADMIN_PASSWORD to the password printed by the seed');

async function signIn(page: Page) {
	await page.goto('/admin/login');
	await page.getByLabel('Email').fill('admin@sortea.local');
	await page.getByLabel('Contraseña').fill(password!);
	await page.getByRole('button', { name: 'Ingresar' }).click();
	await page.getByRole('link', { name: 'Plataforma' }).click();
}

async function createOrganization(page: Page) {
	const suffix = Date.now().toString(36);
	await page.getByLabel('Nombre').fill(`Prueba MP ${suffix}`);
	await page.getByLabel('Identificador').fill(`prueba-mp-${suffix}`);
	await page.getByLabel('Prefijo de comprobantes').fill('PMP');
	await page.getByLabel('Dominio principal').fill(`prueba-mp-${suffix}.localhost`);
	await page.getByRole('button', { name: 'Crear organización' }).click();
	await expect(page.getByRole('heading', { name: `Prueba MP ${suffix}` })).toBeVisible();
	await page.waitForLoadState('networkidle');
}

const panel = (page: Page) => page.getByRole('region', { name: 'Mercado Pago' });

test('connect checks the credentials in one step, shows the webhook URL and disconnect erases them', async ({ page }) => {
	await signIn(page);
	await createOrganization(page);
	await expect(panel(page).getByText('Sin credenciales: esta organización todavía no puede cobrar.')).toBeVisible();
	const organizationId = page.url().split('/').pop()!;
	await expect(panel(page).getByLabel('URL de notificaciones')).toHaveValue(new RegExp(`/webhooks/mercadopago/${organizationId}$`));

	// Refused credentials store nothing and say why.
	await panel(page).getByLabel('Access token').fill('APP_USR-1234567890-refused-locally');
	await panel(page).getByLabel('Clave secreta de notificaciones').fill('whsec-e2e-0123456789abcdef');
	await panel(page).getByRole('button', { name: 'Conectar cuenta' }).click();
	await expect(panel(page).getByRole('alert')).toHaveText('Mercado Pago rechazó las credenciales (HTTP 401). Revisá el access token y el entorno elegido.');
	await expect(panel(page).getByText('Sin credenciales: esta organización todavía no puede cobrar.')).toBeVisible();

	await panel(page).getByLabel('Access token').fill(`TEST-e2e-${Date.now()}-connect`);
	await panel(page).getByLabel('Clave secreta de notificaciones').fill('whsec-e2e-0123456789abcdef');
	await panel(page).getByRole('button', { name: 'Conectar cuenta' }).click();
	await expect(panel(page).getByRole('status')).toHaveText('Cuenta conectada: Mercado Pago confirmó las credenciales y ya se puede cobrar.');
	await expect(panel(page).getByText('Verificada')).toBeVisible();
	await expect(panel(page).getByText('Activa')).toBeVisible();
	await expect(panel(page).getByText(/Cuenta sim-[0-9a-f]{10}\./)).toBeVisible();
	await expect(panel(page).getByLabel('Access token')).toHaveValue('');

	await panel(page).getByLabel('Entiendo que se borran las credenciales y el sitio deja de cobrar').check();
	await panel(page).getByRole('button', { name: 'Desvincular cuenta' }).click();
	await expect(panel(page).getByRole('status')).toHaveText('Cuenta desvinculada: se borraron las credenciales y el sitio dejó de cobrar.');
	await expect(panel(page).getByText('Sin credenciales: esta organización todavía no puede cobrar.')).toBeVisible();
	await expect(panel(page).getByRole('button', { name: 'Desvincular cuenta' })).toHaveCount(0);
});
