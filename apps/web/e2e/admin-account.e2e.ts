import { expect, test, type Page } from '@playwright/test';
import { openAccount, openUserMenu, signOut } from './admin-account';

// Owner feedback 2026-11-10 S11: one section for the signed-in user (password,
// two-step verification, sign out) and a theme for the back office with the
// site's variants, chosen per browser; the public site keeps its own default.
const password = process.env.E2E_ADMIN_PASSWORD;
test.skip(!password, 'Set E2E_ADMIN_PASSWORD to the password printed by the seed');

async function signIn(page: Page) {
	await page.goto('/admin/login');
	await page.getByLabel('Email').fill('owner@tallerdemo.local');
	await page.getByLabel('Contraseña').fill(password!);
	await page.getByRole('button', { name: 'Ingresar' }).click();
	await expect(page.getByRole('navigation', { name: 'Panel' })).toBeVisible();
}

test('the user menu leads to the account, which groups password, two-step verification and sign out', async ({ page }) => {
	await signIn(page);
	const nav = page.getByRole('navigation', { name: 'Panel' });
	for (const name of ['Cambiar contraseña', 'Verificación en dos pasos', 'Mi cuenta']) await expect(nav.getByRole('link', { name })).toHaveCount(0);

	await openAccount(page);
	await expect(page.getByRole('heading', { name: 'Mi cuenta', level: 1 })).toBeVisible();
	await expect(page.getByRole('main').getByRole('link', { name: 'Cambiar contraseña' })).toHaveAttribute('href', '/admin/contrasena');
	await expect(page.getByRole('heading', { name: 'Verificación en dos pasos' })).toBeVisible();
	await expect(page.getByRole('main').getByRole('button', { name: 'Cerrar sesión' })).toBeVisible();

	await signOut(page);
	await expect(page).toHaveURL(/\/admin\/login$/);
});

test('the back-office theme is kept for this browser and leaves the public site alone', async ({ page, context }) => {
	await context.clearCookies();
	const html = page.locator('html');
	await page.goto('/', { waitUntil: 'networkidle' });
	const site = (await html.getAttribute('data-mode')) as 'dark' | 'light';
	const other = site === 'dark' ? 'light' : 'dark';

	await signIn(page);
	await openAccount(page);
	await page.getByRole('radio', { name: other === 'light' ? 'Claro' : 'Oscuro' }).check();
	await page.getByRole('button', { name: 'Guardar tema' }).click();
	await expect(html).toHaveAttribute('data-mode', other);
	const cookie = (await context.cookies()).find((item) => item.name === 'sortea_admin_mode');
	expect(cookie).toMatchObject({ value: other, path: '/admin', httpOnly: true, sameSite: 'Lax' });

	// Rendered by the server in the chosen mode: no flash on the next load.
	await page.goto('/admin/pedidos');
	await expect(html).toHaveAttribute('data-mode', other);
	await page.goto('/', { waitUntil: 'networkidle' });
	await expect(html).toHaveAttribute('data-mode', site);

	// Only light and dark are offered (console polish 2026-11-11, S2); the chosen one is checked.
	await page.goto('/admin/cuenta', { waitUntil: 'networkidle' });
	await expect(page.getByRole('radio')).toHaveCount(2);
	await expect(page.getByRole('radio', { name: other === 'light' ? 'Claro' : 'Oscuro' })).toBeChecked();

	// Back to the other mode, which the next load renders too.
	await page.getByRole('radio', { name: site === 'light' ? 'Claro' : 'Oscuro' }).check();
	await page.getByRole('button', { name: 'Guardar tema' }).click();
	await expect(html).toHaveAttribute('data-mode', site);
	await page.reload();
	await expect(html).toHaveAttribute('data-mode', site);
	await expect((await openUserMenu(page)).getByRole('link', { name: 'Mi cuenta' })).toHaveAttribute('aria-current', 'page');
});
