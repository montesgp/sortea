import { expect, test, type Page } from '@playwright/test';

// Seeded local accounts share one password (SEED_ADMIN_PASSWORD in .env).
const password = process.env.E2E_ADMIN_PASSWORD;

async function signIn(page: Page, email: string) {
	await page.goto('/admin/login');
	await page.getByLabel('Email').fill(email);
	await page.getByLabel('Contraseña').fill(password!);
	await page.getByRole('button', { name: 'Ingresar' }).click();
	await expect(page.getByRole('heading', { name: 'Resumen' })).toBeVisible();
}

const menu = (page: Page) => page.getByRole('navigation', { name: 'Principal' });

// S2/S5 (feedback 2026-10-16): MotoGarage keeps the page but hides it from the home and the menu.
test('the restorations gallery keeps its page, with example photos credited to their authors, off the home and the menu (S12, S2, S5)', async ({ page }) => {
	await page.goto('/');
	await expect(page.getByRole('main')).toBeVisible();
	await expect(page.getByRole('region', { name: 'Restauraciones' })).toHaveCount(0);
	await expect(page.getByRole('link', { name: 'Ver restauraciones' })).toHaveCount(0);
	await expect(menu(page).getByRole('link', { name: 'Restauraciones' })).toHaveCount(0);

	await page.goto('/restauraciones');
	await expect(page.getByRole('heading', { level: 1, name: 'Restauraciones' })).toBeVisible();
	await expect(page.getByText('Fotos de ejemplo de motos clásicas')).toBeVisible();
	await expect(page).toHaveTitle(/Restauraciones/);

	const photos = page.getByRole('main').getByRole('figure');
	const count = await photos.count();
	expect(count).toBeGreaterThanOrEqual(4);
	expect(count).toBeLessThanOrEqual(6);
	for (let index = 0; index < count; index++) {
		const photo = photos.nth(index);
		expect(await photo.getByRole('img').getAttribute('alt')).toMatch(/\S{3,}/);
		const credit = photo.getByRole('link', { name: /Wikimedia Commons/ });
		await expect(credit).toHaveAttribute('href', /^https:\/\/commons\.wikimedia\.org\/wiki\/File:/);
		await expect(credit).toHaveAttribute('rel', /noopener/);
		await expect(photo).toContainText(/Foto: .+ · .+ · Wikimedia Commons/);
	}
});

test('the editor turns the home teaser and the menu link on and off', async ({ page }) => {
	test.skip(!password, 'Set E2E_ADMIN_PASSWORD to the password printed by the seed');
	await signIn(page, 'owner@motogarage.local');
	await page.goto('/admin/sitio?tab=restauraciones');
	const onHome = page.getByLabel('Mostrar un adelanto en el inicio');
	const inMenu = page.getByLabel('Mostrar en el menú');
	await expect(onHome).not.toBeChecked();
	await expect(inMenu).not.toBeChecked();

	await onHome.check();
	await inMenu.check();
	await page.getByRole('button', { name: 'Guardar y publicar' }).click();
	await expect(page.getByRole('status')).toContainText('Publicado');
	const visitor = await page.context().newPage();
	await visitor.goto('/');
	const teaser = visitor.getByRole('region', { name: 'Restauraciones' });
	await expect(teaser.getByRole('img')).toHaveCount(3);
	await expect(menu(visitor).getByRole('link', { name: 'Restauraciones' })).toHaveAttribute('href', '/restauraciones');
	await teaser.getByRole('link', { name: 'Ver restauraciones' }).click();
	await expect(visitor).toHaveURL(/\/restauraciones$/);

	// Leave the site as it was: the page only.
	await page.goto('/admin/sitio?tab=restauraciones');
	await expect(onHome).toBeChecked();
	await onHome.uncheck();
	await inMenu.uncheck();
	await page.getByRole('button', { name: 'Guardar y publicar' }).click();
	await expect(page.getByRole('status')).toContainText('Publicado');
	await visitor.goto('/');
	await expect(visitor.getByRole('region', { name: 'Restauraciones' })).toHaveCount(0);
	await expect(menu(visitor).getByRole('link', { name: 'Restauraciones' })).toHaveCount(0);
	await visitor.goto('/restauraciones');
	await expect(visitor.getByRole('heading', { level: 1, name: 'Restauraciones' })).toBeVisible();
});

test('a draft saved in the Restauraciones tab does not change the public page', async ({ page }) => {
	test.skip(!password, 'Set E2E_ADMIN_PASSWORD to the password printed by the seed');
	const marker = `Borrador e2e-${Date.now()}`;
	await signIn(page, 'owner@motogarage.local');
	await page.goto('/admin/sitio?tab=restauraciones');
	await expect(page.getByRole('heading', { name: 'Restauraciones' })).toBeVisible();

	const firstTitle = page.getByLabel('Título 1', { exact: true });
	const published = await firstTitle.inputValue();
	expect(published).not.toBe('');
	await firstTitle.fill(marker);
	await expect(page.getByLabel('Fuente 1', { exact: true })).toHaveValue(/^https:\/\/commons\.wikimedia\.org\//);
	await page.getByRole('button', { name: 'Guardar borrador' }).click();
	await expect(page.getByRole('status')).toContainText('Borrador guardado');
	await expect(page.getByText('Borrador sin publicar')).toBeVisible();
	await expect(page.getByLabel('Título 1', { exact: true })).toHaveValue(marker);

	const publicPage = await page.context().newPage();
	await publicPage.goto('/restauraciones');
	await expect(publicPage.getByRole('main')).toContainText(published);
	await expect(publicPage.getByText(marker)).toHaveCount(0);

	// Leave the site as it was.
	await page.getByRole('button', { name: 'Descartar borrador' }).click();
	await expect(page.getByRole('status')).toContainText('Borrador descartado');
	await expect(page.getByLabel('Título 1', { exact: true })).toHaveValue(published);
});
