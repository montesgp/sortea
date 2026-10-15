import { expect, test, type Page } from '@playwright/test';

// Seeded local accounts share one password (SEED_ADMIN_PASSWORD in .env).
const password = process.env.E2E_ADMIN_PASSWORD;
test.skip(!password, 'Set E2E_ADMIN_PASSWORD to the password printed by the seed');

/** A real 1×1 PNG; trailing bytes after IEND make each run a different file. */
const png = (marker: string) =>
	Buffer.concat([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'), Buffer.from(marker)]);

async function signIn(page: Page, email: string) {
	await page.goto('/admin/login');
	await page.getByLabel('Email').fill(email);
	await page.getByLabel('Contraseña').fill(password!);
	await page.getByRole('button', { name: 'Ingresar' }).click();
	await expect(page.getByRole('heading', { name: 'Resumen' })).toBeVisible();
}

async function openTab(page: Page, label: string) {
	await page.getByRole('navigation', { name: 'Secciones del sitio' }).getByRole('link', { name: label }).click();
	await page.waitForLoadState('networkidle');
}

test('the owner publishes a banner: invisible as a draft, on every page once published (FR-CMS-04)', async ({ page }) => {
	const text = `Aviso e2e-${Date.now()}`;
	await signIn(page, 'owner@motogarage.local');
	await page.getByRole('link', { name: 'Sitio' }).click();
	await expect(page.getByRole('heading', { name: 'Sitio' })).toBeVisible();
	await openTab(page, 'Aviso');

	await page.getByLabel('Mostrar el aviso').check();
	await page.getByLabel('Texto', { exact: true }).fill(text);
	await page.getByLabel('Enlace', { exact: true }).fill('/sorteos');
	await page.getByLabel('Texto del enlace').fill('Ver sorteos');
	await page.getByRole('button', { name: 'Guardar borrador' }).click();
	await expect(page.getByRole('status')).toContainText('Borrador guardado');
	await expect(page.getByText('Borrador sin publicar')).toBeVisible();

	const publicPage = await page.context().newPage();
	await publicPage.goto('/');
	await expect(publicPage.getByText(text)).toHaveCount(0);

	await page.getByRole('button', { name: 'Guardar y publicar' }).click();
	await expect(page.getByRole('status')).toContainText('Publicado: versión');
	await publicPage.goto('/');
	const banner = publicPage.getByRole('complementary', { name: 'Aviso' });
	await expect(banner).toContainText(text);
	await expect(banner.getByRole('link', { name: 'Ver sorteos' })).toHaveAttribute('href', '/sorteos');
	await publicPage.goto('/sorteos');
	await expect(publicPage.getByRole('complementary', { name: 'Aviso' })).toContainText(text);

	// Leave the site as it was: the banner stays published but hidden.
	await page.waitForLoadState('networkidle');
	await page.getByLabel('Mostrar el aviso').uncheck();
	await page.getByRole('button', { name: 'Guardar y publicar' }).click();
	await expect(page.getByRole('status')).toContainText('Publicado: versión');
	await publicPage.goto('/');
	await expect(publicPage.getByRole('complementary', { name: 'Aviso' })).toHaveCount(0);
});

test('an uploaded image becomes the link preview image, served from the public bucket', async ({ page }) => {
	const filename = `preview-${Date.now()}.png`;
	await signIn(page, 'owner@motogarage.local');
	await page.goto('/admin/sitio?tab=imagenes');
	await page.waitForLoadState('networkidle');

	await page.getByLabel('Imagen', { exact: true }).setInputFiles({ name: filename, mimeType: 'image/png', buffer: png(filename) });
	await page.getByRole('button', { name: 'Subir imagen' }).click();
	await expect(page.getByRole('status')).toContainText(`Imagen subida: ${filename}`);

	const svgName = `falsa-${Date.now()}.png`;
	await page.getByLabel('Imagen', { exact: true }).setInputFiles({ name: svgName, mimeType: 'image/png', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>') });
	await page.getByRole('button', { name: 'Subir imagen' }).click();
	await expect(page.getByRole('alert')).toContainText('Subí una imagen JPEG, PNG o WebP');
	await expect(page.getByText(svgName)).toHaveCount(0);

	await openTab(page, 'Buscadores y redes');
	await page.getByLabel('Título', { exact: true }).fill('MotoGarage | Motos, motores y restauraciones en Arrecifes.');
	await page.getByLabel('Descripción', { exact: true }).fill('Taller, restauraciones, clásicas y coleccionables en Arrecifes.');
	await page.getByLabel('Imagen para compartir').selectOption({ label: filename });
	await page.getByRole('button', { name: 'Guardar y publicar' }).click();
	await expect(page.getByRole('status')).toContainText('Publicado: versión');

	const publicPage = await page.context().newPage();
	await publicPage.goto('/');
	await expect(publicPage).toHaveTitle('MotoGarage | Motos, motores y restauraciones en Arrecifes.');
	const image = await publicPage.locator('meta[property="og:image"]').getAttribute('content');
	expect(image).toMatch(/\/storage\/v1\/object\/public\/site-media\/[0-9a-f-]{36}\/[0-9a-f]{64}\.png$/);
	const served = await page.request.get(image!);
	expect(served.status()).toBe(200);
	expect(served.headers()['content-type']).toBe('image/png');

	// An image in use cannot be deleted; once replaced, it can.
	await page.goto('/admin/sitio?tab=imagenes');
	const item = page.locator('.library li').filter({ hasText: filename });
	await expect(item.getByText('En uso')).toBeVisible();
	await openTab(page, 'Buscadores y redes');
	await page.getByLabel('Imagen para compartir').selectOption({ label: 'Sin imagen' });
	await page.getByRole('button', { name: 'Guardar y publicar' }).click();
	await expect(page.getByRole('status')).toContainText('Publicado: versión');
	await openTab(page, 'Imágenes');
	await page.locator('.library li').filter({ hasText: filename }).getByRole('button', { name: 'Borrar' }).click();
	await expect(page.getByRole('status')).toContainText('Imagen borrada');
	expect((await page.request.get(image!)).status()).not.toBe(200);
});

test('a rejected save names the field and keeps what was typed', async ({ page }) => {
	await signIn(page, 'owner@motogarage.local');
	await page.goto('/admin/sitio?tab=inicio');
	await page.waitForLoadState('networkidle');
	const title = await page.getByLabel('Título principal').inputValue();

	await page.getByLabel('Título principal').fill(`${title} (sin guardar)`);
	await page.getByLabel('Video (YouTube)').fill('https://vimeo.com/123456');
	await page.getByRole('button', { name: 'Guardar borrador' }).click();
	await expect(page.getByRole('alert')).toContainText('Video: Usá un enlace de YouTube (https)');
	await expect(page.getByLabel('Título principal')).toHaveValue(`${title} (sin guardar)`);
	await expect(page.getByLabel('Video (YouTube)')).toHaveValue('https://vimeo.com/123456');

	await page.goto('/admin/sitio?tab=inicio');
	await expect(page.getByLabel('Título principal')).toHaveValue(title);
});

test('site FAQs appear on the home page as soon as they are saved', async ({ page }) => {
	const question = `¿Pregunta e2e-${Date.now()}?`;
	const answer = `Respuesta de la prueba automática ${Date.now()}.`;
	await signIn(page, 'owner@motogarage.local');
	await page.goto('/admin/sitio?tab=preguntas');
	await page.waitForLoadState('networkidle');

	// Added twice, as a double submit would: the home page must still render both.
	for (let copy = 0; copy < 2; copy++) {
		await page.waitForLoadState('networkidle');
		const form = page.locator('form.new-faq');
		await form.getByLabel('Pregunta').fill(question);
		await form.getByLabel('Respuesta').fill(answer);
		await form.getByRole('button', { name: 'Agregar pregunta' }).click();
		await expect(page.getByRole('status')).toContainText('Pregunta agregada');
	}

	const publicPage = await page.context().newPage();
	const errors: string[] = [];
	publicPage.on('pageerror', (error) => errors.push(error.message));
	await publicPage.goto('/');
	await publicPage.waitForLoadState('networkidle');
	const faqs = publicPage.getByRole('region', { name: 'Preguntas frecuentes' });
	await expect(faqs.getByText(question)).toHaveCount(2);
	await faqs.getByText(question).first().click();
	await expect(faqs.getByText(answer).first()).toBeVisible();
	expect(errors).toEqual([]);

	for (let copy = 0; copy < 2; copy++) {
		await page.waitForLoadState('networkidle');
		await page.locator('article.faq').filter({ has: page.locator(`input[value="${question}"]`) }).first().getByRole('button', { name: 'Borrar' }).click();
		await expect(page.getByRole('status')).toContainText('Pregunta borrada');
	}
	await expect(page.locator(`input[value="${question}"]`)).toHaveCount(0);
	await publicPage.goto('/');
	await expect(publicPage.getByText(question)).toHaveCount(0);
});

test('operators cannot edit the site', async ({ page }) => {
	await signIn(page, 'operador@motogarage.local');
	await expect(page.getByRole('link', { name: 'Sitio' })).toHaveCount(0);
	const response = await page.goto('/admin/sitio');
	expect(response?.status()).toBe(403);
});
