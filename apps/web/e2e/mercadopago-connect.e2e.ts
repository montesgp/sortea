import { createHmac } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';

// A platform admin connects an organization's Mercado Pago account in one step,
// adds a backup account, verifies each one on its own and disconnects them later
// (odd/tasks/mercadopago-connect.md, S1-S3; odd/tasks/mercadopago-account-switch.md,
// S1, S4, S6; odd/tasks/console-polish-2026-11-11.md, S4-S6). Locally the payment
// simulator stands in for Mercado Pago and accepts TEST- tokens. Only the test
// organization below is touched.
//
// Switching and disconnecting ask for the admin's authenticator code (S5), so the
// seed admin needs a confirmed app: enrol it once at /admin/mfa as admin@sortea.local
// and set E2E_ADMIN_TOTP_SECRET to the secret shown there (base32).

const password = process.env.E2E_ADMIN_PASSWORD;
const totpSecret = process.env.E2E_ADMIN_TOTP_SECRET;
test.skip(!password, 'Set E2E_ADMIN_PASSWORD to the password printed by the seed');
test.skip(!totpSecret, 'Set E2E_ADMIN_TOTP_SECRET to the authenticator secret of admin@sortea.local');

/** RFC 6238 with the app's parameters (SHA-1, 30 seconds, 6 digits), as the authenticator app computes it. */
function totp(base32: string, step: number) {
	const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
	let bits = '';
	for (const char of base32.replace(/=+$/, '').toUpperCase()) bits += alphabet.indexOf(char).toString(2).padStart(5, '0');
	const secret = Buffer.from(bits.match(/.{8}/g)!.map((byte) => parseInt(byte, 2)));
	const counter = Buffer.alloc(8);
	counter.writeBigUInt64BE(BigInt(step));
	const mac = createHmac('sha1', secret).update(counter).digest();
	const offset = mac[mac.length - 1]! & 0x0f;
	return ((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).toString().padStart(6, '0');
}

/** Each code is accepted once (the API keeps the last step used), so wait for a step not used yet. */
let lastStep = 0;
async function nextCode(): Promise<string> {
	let step = Math.floor(Date.now() / 30_000);
	while (step <= lastStep) {
		await new Promise((resolve) => setTimeout(resolve, 1_000));
		step = Math.floor(Date.now() / 30_000);
	}
	lastStep = step;
	return totp(totpSecret!, step);
}

async function signIn(page: Page) {
	await page.goto('/admin/login');
	await page.getByLabel('Email').fill('admin@sortea.local');
	await page.getByLabel('Contraseña').fill(password!);
	await page.getByRole('button', { name: 'Ingresar' }).click();
	await page.waitForURL((url) => !url.pathname.endsWith('/login'));
	// Where the second factor is required, the code comes first.
	if (new URL(page.url()).pathname.endsWith('/mfa')) {
		await page.getByLabel('Código').fill(await nextCode());
		await page.getByRole('button', { name: 'Verificar' }).click();
		await page.waitForURL((url) => !url.pathname.endsWith('/mfa'));
	}
	await page.getByRole('link', { name: 'Organizaciones' }).click();
}

/** "Desvincular cuenta" in two steps: what will happen, then the code. */
async function disconnectAll(page: Page) {
	await panel(page).getByRole('button', { name: 'Desvincular cuenta' }).click();
	await expect(panel(page)).toContainText('¿Desvincular Mercado Pago?');
	await panel(page).getByLabel('Código de tu app de autenticación').fill(await nextCode());
	await panel(page).getByRole('button', { name: 'Confirmar desvinculación' }).click();
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
		await disconnectAll(page);
		await expect(panel(page).getByRole('status')).toContainText('Mercado Pago desvinculado');
	}
}

const panel = (page: Page) => page.getByRole('region', { name: 'Mercado Pago' });
/** The organization page shows one box per tab, Mercado Pago first (owner feedback 2026-11-10, S2). */
const organizationTab = (page: Page, name: string) => page.getByRole('navigation', { name: 'Secciones de la organización' }).getByRole('link', { name }).click();

/** The first account (the principal), or the backup in its slot of the console. */
async function connect(page: Page, accessToken: string, webhookSecret = 'whsec-e2e-0123456789abcdef', role: 'principal' | 'backup' = 'principal') {
	const scope = role === 'backup' ? panel(page).getByRole('group', { name: 'Cuenta de respaldo' }) : panel(page);
	// Exact labels: each account's «Actualizar credenciales» has "Access token nuevo" and "Firma secreta del webhook nueva".
	await scope.getByLabel('Access token', { exact: true }).fill(accessToken);
	await scope.getByLabel('Firma secreta del webhook', { exact: true }).fill(webhookSecret);
	await scope.getByRole('button', { name: role === 'backup' ? 'Conectar cuenta de respaldo' : 'Conectar cuenta', exact: true }).click();
}

/** The merchant id the simulator derived from the principal's token. */
async function activeCollector(page: Page): Promise<string> {
	const text = await panel(page).getByRole('group', { name: 'Cuenta principal' }).innerText();
	return /Cuenta (sim-[0-9a-f]{10})\./.exec(text)![1]!;
}

test('connect checks the credentials in one step, shows the webhook URL and disconnect erases them', async ({ page }) => {
	await signIn(page);
	await openTestOrganization(page);
	await expect(panel(page).getByText('Sin credenciales: esta organización todavía no puede cobrar.')).toBeVisible();
	const organizationId = new URL(page.url()).pathname.split('/').pop()!;
	await expect(panel(page).getByLabel('URL de notificaciones')).toHaveValue(new RegExp(`/webhooks/mercadopago/${organizationId}$`));
	// The steps name the order event of the Orders API, not the payments one
	// (odd/tasks/mercadopago-orders-api.md, S5).
	const steps = panel(page).getByRole('list', { name: 'Notificaciones de pago' });
	await expect(steps).toContainText('Configuración de webhooks');
	await expect(steps).toContainText('Order (Mercado Pago)');
	await expect(steps).toContainText('Contracargos');
	await expect(steps).not.toContainText('Pagos');
	// The secret is Mercado Pago's webhook "Firma secreta", not the application's Client Secret (2026-11-10).
	await expect(steps).toContainText('Firma secreta');
	await expect(steps).toContainText('No es el Client Secret de Credenciales.');
	await expect(panel(page).getByLabel('Firma secreta del webhook', { exact: true })).toHaveAccessibleDescription(
		'En Mercado Pago: tu aplicación → Configuración de webhooks → Firma secreta. No es el Client Secret de Credenciales.'
	);

	// Refused credentials store nothing and say why.
	await connect(page, 'APP_USR-1234567890-refused-locally');
	await expect(panel(page).getByRole('alert')).toHaveText('Mercado Pago rechazó las credenciales (HTTP 401). Revisá el access token y el entorno elegido.');
	await expect(panel(page).getByText('Sin credenciales: esta organización todavía no puede cobrar.')).toBeVisible();

	await connect(page, `TEST-e2e-${Date.now()}-connect`);
	await expect(panel(page).getByRole('status')).toHaveText('Cuenta conectada: Mercado Pago confirmó las credenciales y ya se puede cobrar.');
	await expect(panel(page).getByText('Verificada')).toBeVisible();
	await expect(panel(page).getByRole('group', { name: 'Cuenta principal' }).getByText('Activa', { exact: true })).toBeVisible();
	await expect(panel(page).getByText(/Cuenta sim-[0-9a-f]{10}\./)).toBeVisible();
	// The simulator's accounts are recorded as such on connect (ADR 0013, 2026-11-07); only a real
	// Mercado Pago test user shows "Cuenta de prueba de Mercado Pago".
	const activeGroup = panel(page).getByRole('group', { name: 'Cuenta principal' });
	await expect(activeGroup.getByText('Simulador local')).toBeVisible();
	await expect(activeGroup.getByText('Cuenta de prueba de Mercado Pago')).toHaveCount(0);
	await expect(panel(page).getByLabel('Access token', { exact: true })).toHaveValue('');

	await disconnectAll(page);
	await expect(panel(page).getByRole('status')).toHaveText('Mercado Pago desvinculado: se borraron las credenciales de todas las cuentas y el sitio dejó de cobrar.');
	await expect(panel(page).getByText('Sin credenciales: esta organización todavía no puede cobrar.')).toBeVisible();
	await expect(panel(page).getByRole('button', { name: 'Desvincular cuenta' })).toHaveCount(0);
});

test('a backup account is verified on its own, "Usar como principal" asks for the code, and previous accounts stay listed (2026-11-11)', async ({ page }) => {
	await signIn(page);
	await openTestOrganization(page);
	await connect(page, `TEST-e2e-${Date.now()}-first`);
	await expect(panel(page).getByRole('status')).toHaveText('Cuenta conectada: Mercado Pago confirmó las credenciales y ya se puede cobrar.');
	const first = await activeCollector(page);
	await expect(panel(page).getByRole('list', { name: 'Cuentas anteriores' })).toHaveCount(0);
	// Switching goes through the backup account (console-polish-2026-11-11, S4, S5): no form connects another principal.
	await expect(panel(page).getByRole('heading', { name: 'Cambiar de cuenta' })).toHaveCount(0);

	// The empty backup slot connects an account that is verified but does not charge.
	const backupGroup = panel(page).getByRole('group', { name: 'Cuenta de respaldo' });
	await connect(page, `TEST-e2e-${Date.now()}-backup`, undefined, 'backup');
	await expect(panel(page).getByRole('status')).toHaveText('Cuenta de respaldo conectada: Mercado Pago confirmó las credenciales. No cobra hasta que uses «Usar como principal».');
	await expect(backupGroup.getByText('Verificada', { exact: true })).toBeVisible();
	await expect(backupGroup.getByText('Respaldo, no cobra')).toBeVisible();
	const backup = /Cuenta (sim-[0-9a-f]{10})\./.exec(await backupGroup.innerText())![1]!;
	expect(backup).not.toBe(first);
	expect(await activeCollector(page)).toBe(first);
	// Its own last notification, separate from the principal's.
	await expect(backupGroup).toContainText(/Sin notificaciones de esta cuenta todavía|Última notificación firmada con esta cuenta/);

	// "Verificar conexión" checks the backup on its own and never switches (S6).
	await backupGroup.getByRole('button', { name: 'Verificar conexión' }).click();
	await expect(backupGroup.getByRole('status')).toHaveText(`Conexión verificada: Mercado Pago respondió por la cuenta ${backup}.`);
	expect(await activeCollector(page)).toBe(first);

	// "Usar como principal" first says what happens, then asks for the authenticator code (S5).
	await backupGroup.getByRole('button', { name: 'Usar como principal' }).click();
	await expect(page).toHaveURL(/tab=mercadopago/);
	await expect(backupGroup).toContainText(`Las compras nuevas se cobran con la cuenta ${backup}.`);
	await expect(backupGroup).toContainText('Las compras ya iniciadas siguen con la cuenta con la que se crearon.');
	await expect(backupGroup).toContainText(`La cuenta ${first} queda como respaldo.`);
	// A wrong code changes nothing and keeps the confirmation open; Cancelar closes it.
	const right = await nextCode();
	await backupGroup.getByLabel('Código de tu app de autenticación').fill(right === '000000' ? '111111' : '000000');
	await backupGroup.getByRole('button', { name: 'Confirmar cambio' }).click();
	await expect(backupGroup.getByRole('alert')).toContainText('El código de tu app de autenticación no es válido');
	expect(await activeCollector(page)).toBe(first);
	await backupGroup.getByRole('link', { name: 'Cancelar' }).click();
	await expect(backupGroup.getByRole('button', { name: 'Usar como principal' })).toBeVisible();

	// With the right code the roles swap: the backup charges and the former principal is the backup.
	await backupGroup.getByRole('button', { name: 'Usar como principal' }).click();
	await backupGroup.getByLabel('Código de tu app de autenticación').fill(await nextCode());
	await backupGroup.getByRole('button', { name: 'Confirmar cambio' }).click();
	await expect(panel(page).getByRole('status')).toContainText('La cuenta de respaldo ahora es la principal');
	expect(await activeCollector(page)).toBe(backup);
	await expect(backupGroup).toContainText(`Cuenta ${first}.`);

	// Another backup moves the former principal to "Cuentas anteriores", where it can be checked and used again.
	await backupGroup.getByText('Reemplazar por otra cuenta', { exact: true }).click();
	await connect(page, `TEST-e2e-${Date.now()}-backup-2`, undefined, 'backup');
	await expect(panel(page).getByRole('status')).toContainText('Cuenta de respaldo conectada');
	const previous = panel(page).getByRole('list', { name: 'Cuentas anteriores' }).getByRole('listitem');
	await expect(previous).toHaveCount(1);
	await expect(previous).toContainText(`Cuenta ${first}, Sandbox, retirada el`);
	await expect(previous.getByRole('button', { name: 'Volver a usar esta cuenta' })).toBeVisible();
	await previous.getByRole('button', { name: 'Verificar conexión' }).click();
	await expect(previous.getByRole('status')).toHaveText(`Conexión verificada: Mercado Pago respondió por la cuenta ${first}.`);
	expect(await activeCollector(page)).toBe(backup);

	// Disconnecting asks for the code too: a wrong one deletes nothing.
	await panel(page).getByRole('button', { name: 'Desvincular cuenta' }).click();
	await panel(page).getByLabel('Código de tu app de autenticación').fill('000000');
	await panel(page).getByRole('button', { name: 'Confirmar desvinculación' }).click();
	await expect(panel(page).getByRole('alert')).toContainText(/El código de tu app de autenticación no es válido/);
	expect(await activeCollector(page)).toBe(backup);
	await panel(page).getByRole('link', { name: 'Cancelar' }).click();

	await disconnectAll(page);
	await expect(panel(page).getByRole('status')).toHaveText('Mercado Pago desvinculado: se borraron las credenciales de todas las cuentas y el sitio dejó de cobrar.');
	await expect(panel(page).getByText('Sin credenciales: esta organización todavía no puede cobrar.')).toBeVisible();
	await expect(panel(page).getByRole('list', { name: 'Cuentas anteriores' })).toHaveCount(0);
});

test('updating credentials keeps the account, refuses a token pasted as the secret and another merchant (2026-11-10)', async ({ page }) => {
	await signIn(page);
	await openTestOrganization(page);
	await connect(page, `TEST-e2e-${Date.now()}-update`);
	await expect(panel(page).getByRole('status')).toHaveText('Cuenta conectada: Mercado Pago confirmó las credenciales y ya se puede cobrar.');
	const collector = await activeCollector(page);
	const activeGroup = panel(page).getByRole('group', { name: 'Cuenta principal' });
	await expect(activeGroup).toContainText(/Sin notificaciones de esta cuenta todavía|Última notificación firmada con esta cuenta/);

	// An access token pasted where the webhook secret goes is refused before anything is stored.
	await activeGroup.getByText('Actualizar credenciales', { exact: true }).click();
	await activeGroup.getByLabel('Firma secreta del webhook nueva').fill(`TEST-e2e-${Date.now()}-pasted`);
	await activeGroup.getByRole('button', { name: 'Guardar credenciales' }).click();
	await expect(panel(page).getByRole('alert')).toHaveText(
		'Eso es un access token, no la firma secreta del webhook. Copiala en Mercado Pago: tu aplicación → Configuración de webhooks → Firma secreta.'
	);

	// The simulator derives the merchant from the token, so a new token is another merchant: that is a switch.
	await activeGroup.getByText('Actualizar credenciales', { exact: true }).click();
	await activeGroup.getByLabel('Access token nuevo').fill(`TEST-e2e-${Date.now()}-other`);
	await activeGroup.getByRole('button', { name: 'Guardar credenciales' }).click();
	await expect(panel(page).getByRole('alert')).toContainText('El access token nuevo es de otra cuenta de Mercado Pago');
	await expect(panel(page).getByRole('alert')).toContainText('«Usar como principal»');

	await activeGroup.getByText('Actualizar credenciales', { exact: true }).click();
	await activeGroup.getByLabel('Firma secreta del webhook nueva').fill('whsec-e2e-renewed-0123456789');
	await activeGroup.getByRole('button', { name: 'Guardar credenciales' }).click();
	await expect(panel(page).getByRole('status')).toContainText('Credenciales actualizadas.');
	expect(await activeCollector(page)).toBe(collector);
	await expect(panel(page).getByRole('list', { name: 'Cuentas anteriores' })).toHaveCount(0);
});

test('a domain added by mistake is removed after confirming, and Cancelar keeps it (2026-11-10)', async ({ page }) => {
	await signIn(page);
	await openTestOrganization(page);
	await organizationTab(page, 'Dominios');
	const domains = page.getByRole('region', { name: 'Dominios' });
	const wrong = `e2e-wrong-${Date.now()}.localhost`;
	await domains.getByLabel('Nuevo dominio').fill(wrong);
	await domains.getByRole('button', { name: 'Agregar dominio' }).click();
	await expect(domains.getByRole('status')).toHaveText('Dominio agregado');
	const row = domains.getByRole('listitem').filter({ hasText: wrong });

	await row.getByRole('button', { name: `Quitar ${wrong}` }).click();
	await expect(row).toContainText(`¿Quitar ${wrong}?`);
	await row.getByRole('link', { name: 'Cancelar' }).click();
	await expect(row.getByRole('button', { name: `Quitar ${wrong}` })).toBeVisible();

	await row.getByRole('button', { name: `Quitar ${wrong}` }).click();
	await row.getByRole('button', { name: 'Sí, quitar' }).click();
	await expect(domains.getByRole('status')).toHaveText(`Dominio quitado: ${wrong} ya no abre el sitio de la organización.`);
	await expect(domains.getByRole('listitem').filter({ hasText: wrong })).toHaveCount(0);
	await expect(domains.getByRole('listitem').filter({ hasText: 'e2e-mercadopago.localhost' })).toHaveCount(1);
});

test('suspending asks first, pauses the public site with 503 and keeps the console; reactivating asks too (2026-11-10, S13)', async ({ page }) => {
	await signIn(page);
	await openTestOrganization(page);
	await organizationTab(page, 'Estado');
	const status = page.getByRole('region', { name: 'Estado' });
	// The tab survives the post: the confirmation shows on the same tab.
	await status.getByRole('button', { name: 'Suspender organización' }).click();
	await expect(page).toHaveURL(/tab=estado/);
	await expect(status).toContainText(`¿Suspender ${ORGANIZATION}?`);
	await status.getByRole('link', { name: 'Cancelar' }).click();
	await expect(status.getByRole('button', { name: 'Suspender organización' })).toBeVisible();
	await expect(page.getByText('Activa', { exact: true })).toBeVisible();

	await status.getByRole('button', { name: 'Suspender organización' }).click();
	await status.getByRole('button', { name: 'Sí, suspender' }).click();
	await expect(status.getByRole('status')).toContainText('Organización suspendida');
	const site = new URL(page.url());
	site.hostname = 'e2e-mercadopago.localhost';
	site.pathname = '/';
	site.search = '';
	try {
		const paused = await page.request.get(site.href);
		expect(paused.status()).toBe(503);
		expect(await paused.text()).toContain('Este sitio está pausado momentáneamente');
		// The panel of the suspended organization's own domain still answers (its sign-in page).
		site.pathname = '/admin/login';
		expect((await page.request.get(site.href)).status()).toBe(200);
	} finally {
		await status.getByRole('button', { name: 'Reactivar organización' }).click();
		await expect(status).toContainText(`¿Reactivar ${ORGANIZATION}?`);
		await status.getByRole('button', { name: 'Sí, reactivar' }).click();
		await expect(status.getByRole('status')).toContainText('Organización reactivada');
	}
});
