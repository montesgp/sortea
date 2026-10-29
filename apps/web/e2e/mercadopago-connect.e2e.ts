import { expect, test, type Page } from '@playwright/test';

// A platform admin connects an organization's Mercado Pago account in one step,
// switches to another one and disconnects them later
// (odd/tasks/mercadopago-connect.md, S1-S3; odd/tasks/mercadopago-account-switch.md,
// S1, S4). Locally the payment simulator stands in for Mercado Pago and accepts
// TEST- tokens. Only the test organization below is touched.

const password = process.env.E2E_ADMIN_PASSWORD;
test.skip(!password, 'Set E2E_ADMIN_PASSWORD to the password printed by the seed');

async function signIn(page: Page) {
	await page.goto('/admin/login');
	await page.getByLabel('Email').fill('admin@sortea.local');
	await page.getByLabel('Contraseña').fill(password!);
	await page.getByRole('button', { name: 'Ingresar' }).click();
	await page.getByRole('link', { name: 'Organizaciones' }).click();
}

const ORGANIZATION = 'E2E Mercado Pago';

/** Organizations cannot be deleted, so every run reuses one and starts it without an account. */
async function openTestOrganization(page: Page) {
	const existing = page.getByRole('link', { name: ORGANIZATION, exact: true });
	if ((await existing.count()) > 0) {
		await existing.click();
	} else {
		await page.getByLabel('Nombre').fill(ORGANIZATION);
		await page.getByLabel('Identificador').fill('e2e-mercadopago');
		await page.getByLabel('Prefijo de comprobantes').fill('EMP');
		await page.getByLabel('Dominio principal').fill('e2e-mercadopago.localhost');
		await page.getByRole('button', { name: 'Crear organización' }).click();
	}
	await expect(page.getByRole('heading', { name: ORGANIZATION })).toBeVisible();
	await page.waitForLoadState('networkidle');
	const disconnect = panel(page).getByRole('button', { name: 'Desvincular cuenta' });
	if ((await disconnect.count()) > 0) {
		await panel(page).getByLabel(CONFIRM_DISCONNECT).check();
		await disconnect.click();
		await expect(panel(page).getByRole('status')).toContainText('Mercado Pago desvinculado');
	}
}

const panel = (page: Page) => page.getByRole('region', { name: 'Mercado Pago' });
const CONFIRM_DISCONNECT = 'Entiendo que se borran las credenciales de todas las cuentas y el sitio deja de cobrar';

async function connect(page: Page, accessToken: string) {
	await panel(page).getByLabel('Access token').fill(accessToken);
	await panel(page).getByLabel('Clave secreta de notificaciones').fill('whsec-e2e-0123456789abcdef');
	await panel(page).getByRole('button', { name: 'Conectar cuenta' }).click();
}

/** The merchant id the simulator derived from the active account's token. */
async function activeCollector(page: Page): Promise<string> {
	const text = await panel(page).getByRole('group', { name: 'Cuenta activa' }).innerText();
	return /Cuenta (sim-[0-9a-f]{10})\./.exec(text)![1]!;
}

test('connect checks the credentials in one step, shows the webhook URL and disconnect erases them', async ({ page }) => {
	await signIn(page);
	await openTestOrganization(page);
	await expect(panel(page).getByText('Sin credenciales: esta organización todavía no puede cobrar.')).toBeVisible();
	const organizationId = new URL(page.url()).pathname.split('/').pop()!;
	await expect(panel(page).getByLabel('URL de notificaciones')).toHaveValue(new RegExp(`/webhooks/mercadopago/${organizationId}$`));

	// Refused credentials store nothing and say why.
	await connect(page, 'APP_USR-1234567890-refused-locally');
	await expect(panel(page).getByRole('alert')).toHaveText('Mercado Pago rechazó las credenciales (HTTP 401). Revisá el access token y el entorno elegido.');
	await expect(panel(page).getByText('Sin credenciales: esta organización todavía no puede cobrar.')).toBeVisible();

	await connect(page, `TEST-e2e-${Date.now()}-connect`);
	await expect(panel(page).getByRole('status')).toHaveText('Cuenta conectada: Mercado Pago confirmó las credenciales y ya se puede cobrar.');
	await expect(panel(page).getByText('Verificada')).toBeVisible();
	await expect(panel(page).getByRole('group', { name: 'Cuenta activa' }).getByText('Activa', { exact: true })).toBeVisible();
	await expect(panel(page).getByText(/Cuenta sim-[0-9a-f]{10}\./)).toBeVisible();
	await expect(panel(page).getByLabel('Access token')).toHaveValue('');

	await panel(page).getByLabel(CONFIRM_DISCONNECT).check();
	await panel(page).getByRole('button', { name: 'Desvincular cuenta' }).click();
	await expect(panel(page).getByRole('status')).toHaveText('Mercado Pago desvinculado: se borraron las credenciales de todas las cuentas y el sitio dejó de cobrar.');
	await expect(panel(page).getByText('Sin credenciales: esta organización todavía no puede cobrar.')).toBeVisible();
	await expect(panel(page).getByRole('button', { name: 'Desvincular cuenta' })).toHaveCount(0);
});

test('switching accounts lists the previous one under Cuentas anteriores, and disconnecting deletes both', async ({ page }) => {
	await signIn(page);
	await openTestOrganization(page);
	await connect(page, `TEST-e2e-${Date.now()}-first`);
	await expect(panel(page).getByRole('status')).toHaveText('Cuenta conectada: Mercado Pago confirmó las credenciales y ya se puede cobrar.');
	const first = await activeCollector(page);
	await expect(panel(page).getByRole('list', { name: 'Cuentas anteriores' })).toHaveCount(0);

	// The switch form says what happens to purchases in flight and to the webhooks (S5).
	await expect(panel(page).getByRole('heading', { name: 'Cambiar de cuenta' })).toBeVisible();
	await expect(panel(page).getByText('El cambio vale para las compras que se inicien desde ahora.')).toBeVisible();
	await expect(panel(page).getByText(/no borres el webhook de la cuenta anterior/)).toBeVisible();

	await connect(page, `TEST-e2e-${Date.now()}-second`);
	await expect(panel(page).getByRole('status')).toHaveText(
		'Cuenta cambiada: Mercado Pago confirmó las credenciales. Las compras nuevas se cobran con esta cuenta; las ya iniciadas siguen con la anterior.'
	);
	const second = await activeCollector(page);
	expect(second).not.toBe(first);
	await expect(panel(page).getByRole('group', { name: 'Cuenta activa' })).toContainText('Sandbox');
	const previous = panel(page).getByRole('list', { name: 'Cuentas anteriores' }).getByRole('listitem');
	await expect(previous).toHaveCount(1);
	await expect(previous).toContainText(`Cuenta ${first}, Sandbox, retirada el`);

	await panel(page).getByLabel(CONFIRM_DISCONNECT).check();
	await panel(page).getByRole('button', { name: 'Desvincular cuenta' }).click();
	await expect(panel(page).getByRole('status')).toHaveText('Mercado Pago desvinculado: se borraron las credenciales de todas las cuentas y el sitio dejó de cobrar.');
	await expect(panel(page).getByText('Sin credenciales: esta organización todavía no puede cobrar.')).toBeVisible();
	await expect(panel(page).getByRole('list', { name: 'Cuentas anteriores' })).toHaveCount(0);
});
