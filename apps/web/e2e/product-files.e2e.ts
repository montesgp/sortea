import { expect, test, type Page } from '@playwright/test';

// Owner feedback 2026-11-11b, S2 (decision L2): a ZIP is hard to open on a phone, so a digital product
// carries its images as separate files, each with its own download link. The back office adds,
// replaces and removes them one at a time. The links and their order are covered by
// apps/api/test/product-files.test.ts and apps/worker/test/processor.test.ts.

// Seeded local accounts share one password (SEED_ADMIN_PASSWORD in .env).
const password = process.env.E2E_ADMIN_PASSWORD;
test.skip(!password, 'Set E2E_ADMIN_PASSWORD to the password printed by the seed');

const png = (text: string) => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Buffer.from(text)]);

async function signIn(page: Page, email: string) {
	await page.goto('/admin/login');
	await page.getByLabel('Email').fill(email);
	await page.getByLabel('Contraseña').fill(password!);
	await page.getByRole('button', { name: 'Ingresar' }).click();
	await expect(page.getByRole('heading', { name: 'Resumen' })).toBeVisible();
}

test('the owner gives a digital product several files, replaces one and removes another', async ({ page }) => {
	const slug = `e2e-archivos-${Date.now()}`;
	const name = `Calcomanía ${slug}`;
	await signIn(page, 'owner@tallerdemo.local');
	await page.getByRole('link', { name: 'Productos' }).click();
	await page.getByLabel('Nombre').fill(name);
	await page.getByLabel('Dirección en la tienda').fill(slug);
	await page.getByLabel('Tipo').selectOption('digital');
	await page.getByLabel('Descripción').fill('Calcomanía para descargar, de prueba automática.');
	await page.getByRole('button', { name: 'Crear borrador' }).click();
	await expect(page.getByRole('heading', { name })).toBeVisible();
	await page.waitForLoadState('networkidle');
	await expect(page.getByText('todavía no tiene archivos')).toBeVisible();

	const add = page.locator('form[action="?/addFile"]');
	await add.getByLabel('Archivo', { exact: true }).setInputFiles({ name: 'Calcomanía con borde.png', mimeType: 'image/png', buffer: png('borde') });
	await add.getByRole('button', { name: 'Agregar archivo' }).click();
	await expect(page.getByRole('status')).toContainText('Archivo agregado: Calcomania-con-borde.png');
	await page.waitForLoadState('networkidle');

	await page.locator('summary', { hasText: 'Agregar archivo' }).click();
	await add.getByLabel('Archivo', { exact: true }).setInputFiles({ name: 'IMG_0001.png', mimeType: 'image/png', buffer: png('fondo') });
	await add.getByLabel('Nombre de la descarga (opcional)').fill('Fondo celular');
	await add.getByRole('button', { name: 'Agregar archivo' }).click();
	await expect(page.getByRole('status')).toContainText('Archivo agregado: Fondo-celular.png');
	await page.waitForLoadState('networkidle');

	const files = page.locator('ol.files > li');
	await expect(files.locator('.filename')).toHaveText(['Calcomania-con-borde.png', 'Fondo-celular.png']);
	await expect(files.first()).toContainText('Imagen PNG');

	// Replace the first one in place.
	const first = files.first();
	await first.locator('summary', { hasText: 'Reemplazar o quitar' }).click();
	await first.getByLabel('Archivo nuevo').setInputFiles({ name: 'Calcomania.png', mimeType: 'image/png', buffer: png('sin borde') });
	await first.getByRole('button', { name: 'Reemplazar archivo' }).click();
	await expect(page.getByRole('status')).toContainText('Archivo reemplazado: Calcomania.png');
	await page.waitForLoadState('networkidle');
	await expect(files.locator('.filename')).toHaveText(['Calcomania.png', 'Fondo-celular.png']);

	// Removing asks to acknowledge that its links stop working.
	const second = files.nth(1);
	await second.locator('summary', { hasText: 'Reemplazar o quitar' }).click();
	await second.getByLabel(/Entiendo que los enlaces de este archivo dejan de funcionar/).check();
	await second.getByRole('button', { name: 'Quitar Fondo-celular.png' }).click();
	await expect(page.getByRole('status')).toContainText('Archivo quitado: Fondo-celular.png');
	await expect(files.locator('.filename')).toHaveText(['Calcomania.png']);

	// Leave the shop as it was: nobody bought it, so the list deletes it for good after asking (S10).
	await page.goto('/admin/productos');
	await page.getByRole('button', { name: `Eliminar ${name}` }).click();
	await page.getByRole('button', { name: 'Eliminar definitivamente' }).click();
	await expect(page.getByText(`Producto eliminado: ${name}`)).toBeVisible();
});
