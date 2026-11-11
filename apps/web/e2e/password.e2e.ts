import { expect, test, type Page } from '@playwright/test';
import { openAccount, signOut } from './admin-account';

// "Cambiar contraseña" (ADR 0020): the API checks the current password and
// ends every other session of the user. The seeded operator changes it and
// puts the seed password back, so the other suites keep signing in.
const password = process.env.E2E_ADMIN_PASSWORD;
test.skip(!password, 'Set E2E_ADMIN_PASSWORD to the password printed by the seed');

const email = 'operador@tallerdemo.local';
const changed = `e2e-${password}-cambiada`;

async function signIn(page: Page, secret: string) {
	await page.goto('/admin/login');
	await page.getByLabel('Email').fill(email);
	await page.getByLabel('Contraseña').fill(secret);
	await page.getByRole('button', { name: 'Ingresar' }).click();
}

async function change(page: Page, current: string, next: string) {
	await page.getByLabel('Contraseña actual').fill(current);
	await page.getByLabel('Contraseña nueva', { exact: true }).fill(next);
	await page.getByLabel('Repetí la contraseña nueva').fill(next);
	await page.getByRole('button', { name: 'Cambiar contraseña' }).click();
}

test('an admin changes their password, which ends their other sessions', async ({ browser }) => {
	const other = await browser.newContext();
	const own = await browser.newContext();
	try {
		const elsewhere = await other.newPage();
		await signIn(elsewhere, password!);
		await expect(elsewhere.getByRole('navigation', { name: 'Panel' })).toBeVisible();

		const page = await own.newPage();
		await signIn(page, password!);
		// Reached from "Mi cuenta" in the user menu (owner feedback 2026-11-10 S11).
		await openAccount(page);
		await page.getByRole('link', { name: 'Cambiar contraseña' }).click();
		await expect(page).toHaveURL(/\/admin\/contrasena$/);
		const cookie = (await own.cookies()).find((item) => item.name === 'sortea_admin_session');
		expect(cookie).toMatchObject({ path: '/admin', httpOnly: true, sameSite: 'Lax' });

		await change(page, 'no-es-la-actual', changed);
		await expect(page.getByRole('alert')).toHaveText('La contraseña actual no es correcta');
		await change(page, password!, changed);
		// Earlier runs may have left more sessions of this user open: all of them end, "elsewhere" included.
		await expect(page.getByRole('status')).toHaveText(/^Contraseña cambiada\. Cerramos (tu otra sesión abierta|tus otras \d+ sesiones abiertas)\.$/);

		await elsewhere.reload();
		await expect(elsewhere).toHaveURL(/\/admin\/login/);

		await page.getByRole('link', { name: 'Volver al panel' }).click();
		await signOut(page);
		await signIn(page, changed);
		await expect(page.getByRole('navigation', { name: 'Panel' })).toBeVisible();
		await page.goto('/admin/contrasena');
		await change(page, changed, password!);
		await expect(page.getByRole('status')).toHaveText('Contraseña cambiada.');
	} finally {
		await other.close();
		await own.close();
	}
});

// Owner feedback 2026-11-10: every password field can be shown and hidden, so the
// owner sees what they type while changing the temporary password.
test('each password field of the change form can be shown and hidden', async ({ page }) => {
	await signIn(page, password!);
	await expect(page.getByRole('navigation', { name: 'Panel' })).toBeVisible();
	await page.goto('/admin/contrasena');
	for (const label of ['Contraseña actual', 'Contraseña nueva', 'Repetí la contraseña nueva']) {
		const field = page.getByLabel(label, { exact: true });
		await field.fill('una-clave-de-prueba');
		await expect(field).toHaveAttribute('type', 'password');
		const id = await field.getAttribute('id');
		const eye = page.locator(`button[aria-controls="${id}"]`);
		await expect(eye).toHaveAccessibleName('Mostrar');
		await expect(eye).toHaveAttribute('title', `Mostrar ${label.toLowerCase()}`);
		await expect(eye).toHaveAttribute('aria-pressed', 'false');
		await eye.click();
		await expect(field).toHaveAttribute('type', 'text');
		await expect(field).toHaveValue('una-clave-de-prueba');
		await expect(eye).toHaveAttribute('aria-pressed', 'true');
		await eye.click();
		await expect(field).toHaveAttribute('type', 'password');
	}
});
