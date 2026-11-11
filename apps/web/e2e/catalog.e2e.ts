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

test('the owner creates a product, prices it in es-AR format and puts it on sale (FR-COM-01)', async ({ page }) => {
	const slug = `e2e-${Date.now()}`;
	const name = `Llavero ${slug}`;
	await signIn(page, 'owner@tallerdemo.local');
	await page.getByRole('link', { name: 'Productos' }).click();

	await page.getByLabel('Nombre').fill(name);
	await page.getByLabel('Dirección en la tienda').fill(slug);
	await page.getByLabel('Tipo').selectOption('physical');
	await page.getByLabel('Descripción').fill('Llavero metálico de prueba automática.');
	await page.getByRole('button', { name: 'Crear borrador' }).click();
	await expect(page.getByRole('heading', { name })).toBeVisible();
	await page.waitForLoadState('networkidle');

	await page.getByRole('button', { name: 'Poner a la venta' }).click();
	await expect(page.getByRole('alert')).toContainText('Agregá al menos una variante activa');

	const variantForm = page.locator('form[action="?/addVariant"]');
	await variantForm.getByLabel('Código (SKU)').fill(`LL-${Date.now()}`);
	await variantForm.getByLabel('Nombre').fill('Llavero');
	await variantForm.getByLabel(/Precio final/).fill('15.000,50');
	await variantForm.getByLabel('Stock').fill('3');
	await variantForm.getByRole('button', { name: 'Agregar variante' }).click();
	await expect(page.getByRole('status')).toContainText('Variante agregada');
	await page.waitForLoadState('networkidle');
	await expect(page.getByText('$ 15.000,50')).toBeVisible();

	await page.getByRole('button', { name: 'Poner a la venta' }).click();
	await expect(page.getByText('A la venta', { exact: true })).toBeVisible();

	// The server-rendered form already carries the description: saving before
	// hydration (or without JavaScript) must not blank it.
	const noScript = await page.context().browser()!.newContext({ javaScriptEnabled: false, storageState: await page.context().storageState() });
	const raw = await noScript.newPage();
	await raw.goto(page.url());
	await expect(raw.getByLabel('Descripción')).toHaveValue('Llavero metálico de prueba automática.');
	await noScript.close();
	await page.goto('/tienda');
	await expect(page.getByRole('article').filter({ hasText: name })).toBeVisible();

	// Leave the shop as it was: nobody bought it, so the list deletes it for good after asking (S10).
	await page.goto('/admin/productos');
	await page.getByRole('button', { name: `Eliminar ${name}` }).click();
	await expect(page.getByRole('heading', { name: `¿Eliminar ${name}?` })).toBeVisible();
	await expect(page.getByText('se elimina definitivamente')).toBeVisible();
	await page.getByRole('button', { name: 'Eliminar definitivamente' }).click();
	await expect(page.getByRole('status')).toHaveText(`Producto eliminado: ${name}`);
	await expect(page.getByRole('link', { name })).toHaveCount(0);
	await page.goto('/tienda');
	await expect(page.getByRole('article').filter({ hasText: name })).toHaveCount(0);
});

test('a product a campaign gives chances for is not deleted, and the list says why, without JavaScript (S10)', async ({ page }) => {
	await signIn(page, 'owner@tallerdemo.local');
	// The seeded manual gives chances in the seeded campaign.
	const noScript = await page.context().browser()!.newContext({ javaScriptEnabled: false, storageState: await page.context().storageState() });
	const raw = await noScript.newPage();
	await raw.goto('/admin/productos');
	await raw.getByRole('button', { name: /^Eliminar Manual/ }).first().click();
	await expect(raw.getByRole('heading', { name: /^No se puede eliminar Manual/ })).toBeVisible();
	await expect(raw.getByText(/Quitalo de sus productos y de sus chances/)).toBeVisible();
	await expect(raw.getByRole('button', { name: 'Eliminar definitivamente' })).toHaveCount(0);
	await raw.getByRole('link', { name: 'Volver' }).click();
	await expect(raw.getByRole('heading', { name: /^No se puede eliminar/ })).toHaveCount(0);
	await noScript.close();
});

test('the Archivados tab lists archived products and restores them as drafts (S10)', async ({ page }) => {
	const slug = `e2e-arch-${Date.now()}`;
	const name = `Archivo ${slug}`;
	await signIn(page, 'owner@tallerdemo.local');
	await page.getByRole('link', { name: 'Productos' }).click();
	await page.getByLabel('Nombre').fill(name);
	await page.getByLabel('Dirección en la tienda').fill(slug);
	await page.getByLabel('Descripción').fill('Producto de prueba para archivar.');
	await page.getByRole('button', { name: 'Crear borrador' }).click();
	await expect(page.getByRole('heading', { name })).toBeVisible();
	await page.waitForLoadState('networkidle');
	await page.getByRole('button', { name: 'Archivar' }).click();
	await expect(page.getByText('Producto archivado')).toBeVisible();

	await page.goto('/admin/productos');
	await expect(page.getByRole('link', { name })).toHaveCount(0);
	await page.getByRole('navigation', { name: 'Vistas de productos' }).getByRole('link', { name: /^Archivados/ }).click();
	await expect(page.getByRole('link', { name })).toBeVisible();
	await page.getByRole('button', { name: `Restaurar ${name}` }).click();
	await expect(page.getByRole('status')).toContainText(`${name} volvió como borrador`);
	await page.goto('/admin/productos');
	await expect(page.getByRole('link', { name })).toBeVisible();

	// Nobody ordered it: delete it so the catalog stays as it was.
	await page.getByRole('button', { name: `Eliminar ${name}` }).click();
	await page.getByRole('button', { name: 'Eliminar definitivamente' }).click();
	await expect(page.getByRole('status')).toHaveText(`Producto eliminado: ${name}`);
});

test('operators see products but cannot change them', async ({ page }) => {
	await signIn(page, 'operador@tallerdemo.local');
	await page.getByRole('link', { name: 'Productos' }).click();
	await expect(page.getByRole('heading', { name: 'Productos' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Crear borrador' })).toHaveCount(0);
});

test('prizes can be added and removed while the campaign is not open (FR-CAMP-03)', async ({ page }) => {
	const title = `Casco e2e-${Date.now()}`;
	await signIn(page, 'owner@tallerdemo.local');
	await page.getByRole('link', { name: 'Campañas' }).click();
	await page.getByRole('link', { name: /Honda Tornado/ }).click();
	await expect(page.getByRole('heading', { name: /Honda Tornado/ })).toBeVisible();
	// Interact after hydration, or Svelte re-applies the <details> state the server rendered.
	await page.waitForLoadState('networkidle');

	await page.locator('summary', { hasText: 'Agregar premio' }).click();
	const form = page.locator('form[action="?/addPrize"]');
	await form.getByLabel('Título').fill(title);
	await form.getByLabel('Valor declarado por unidad').fill('250.000');
	await form.getByLabel('Unidades').fill('2');
	await form.getByRole('button', { name: 'Agregar premio' }).click();
	await expect(page.getByRole('status')).toContainText('Premio agregado');
	await page.waitForLoadState('networkidle');
	const item = page.locator('li').filter({ hasText: title });
	await expect(item).toContainText('$ 250.000');

	await item.locator('summary', { hasText: 'Editar' }).click();
	await item.getByRole('button', { name: 'Quitar este premio' }).click();
	await expect(page.getByRole('status')).toContainText('Premio quitado');
	await expect(page.locator('li').filter({ hasText: title })).toHaveCount(0);
});
