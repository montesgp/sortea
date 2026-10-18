import { expect, test, type Page } from '@playwright/test';

// Feedback 2026-10-17 S5: a WhatsApp button on every public page, built from
// the organization's number (MotoGarage seeds +54 9 2478 40-7084).
const password = process.env.E2E_ADMIN_PASSWORD;
const chat = 'https://wa.me/5492478407084?text=Hola%2C%20vengo%20desde%20la%20web';

const whatsapp = (page: Page) => page.getByRole('link', { name: 'Escribinos por WhatsApp' });

function overlaps(a: { x: number; y: number; width: number; height: number }, b: typeof a) {
	return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

test('every public page links to the organization WhatsApp in a new tab', async ({ page }) => {
	for (const path of ['/', '/tienda', '/sorteos/tornado-300']) {
		await page.goto(path);
		const link = whatsapp(page);
		await expect(link, path).toHaveCount(1);
		await expect(link).toBeVisible();
		await expect(link).toHaveAttribute('href', chat);
		await expect(link).toHaveAttribute('target', '_blank');
		await expect(link).toHaveAttribute('rel', /noopener/);
		await expect(link.locator('svg')).toBeVisible();
	}
});

test('on a phone the button floats bottom right without covering the cart CTA', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await page.context().clearCookies();
	await page.goto('/tienda');
	await page.getByRole('button', { name: 'Agregar al carrito' }).first().click();
	await expect(page).toHaveURL(/\/carrito$/);

	const button = (await whatsapp(page).boundingBox())!;
	expect(390 - (button.x + button.width)).toBeLessThanOrEqual(24);
	expect(844 - (button.y + button.height)).toBeLessThanOrEqual(24);
	expect(button.width).toBeGreaterThanOrEqual(44);

	const cta = page.getByRole('link', { name: 'Continuar con la compra' });
	await cta.scrollIntoViewIfNeeded();
	expect(overlaps((await cta.boundingBox())!, (await whatsapp(page).boundingBox())!)).toBe(false);

	// At the very end of the page the footer leaves room, so the last links stay reachable.
	await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
	const lastLink = page.locator('footer a').last();
	expect(overlaps((await lastLink.boundingBox())!, (await whatsapp(page).boundingBox())!)).toBe(false);
});

test('the admin has no WhatsApp button', async ({ page }) => {
	await page.goto('/admin/login');
	await expect(page.getByLabel('Email')).toBeVisible();
	await expect(whatsapp(page)).toHaveCount(0);
});

test('platform staff edit the organization WhatsApp number', async ({ page }) => {
	test.skip(!password, 'Set E2E_ADMIN_PASSWORD to the password printed by the seed');
	await page.goto('/admin/login');
	await page.getByLabel('Email').fill('admin@sortea.local');
	await page.getByLabel('Contraseña').fill(password!);
	await page.getByRole('button', { name: 'Ingresar' }).click();
	await expect(whatsapp(page)).toHaveCount(0);
	await page.getByRole('link', { name: 'Organizaciones' }).click();
	await page.getByRole('link', { name: 'MotoGarage' }).click();
	await page.waitForLoadState('networkidle');

	const field = page.getByLabel('WhatsApp');
	await field.fill('2478 40-7084');
	await page.getByRole('button', { name: 'Guardar contacto' }).click();
	await expect(page.getByRole('alert')).toHaveText('Ingresá el número con código de país, por ejemplo +54 9 2478 40-7084');
	// The rejected value stays in the field to be corrected.
	await expect(page.getByLabel('WhatsApp')).toHaveValue('2478 40-7084');
	await page.waitForLoadState('networkidle');

	await page.getByLabel('WhatsApp').fill('+54 9 2478 40-7084');
	await page.getByRole('button', { name: 'Guardar contacto' }).click();
	await expect(page.getByText('Contacto guardado')).toBeVisible();
	await expect(page.getByLabel('WhatsApp')).toHaveValue('+5492478407084');

	await page.goto('/');
	await expect(whatsapp(page)).toHaveAttribute('href', chat);
});

async function signIn(page: Page, email: string) {
	await page.goto('/admin/login');
	await page.getByLabel('Email').fill(email);
	await page.getByLabel('Contraseña').fill(password!);
	await page.getByRole('button', { name: 'Ingresar' }).click();
	await page.waitForURL((url) => !url.pathname.endsWith('/login'));
}

async function saveOwnWhatsApp(page: Page, value: string) {
	await page.goto('/admin/configuracion');
	await page.waitForLoadState('networkidle');
	await page.getByLabel('WhatsApp').fill(value);
	await page.getByRole('button', { name: 'Guardar contacto' }).click();
}

// The owner changes the number themselves: it "pronto va a cambiar".
test('the owner edits the WhatsApp number in Configuración and the public button follows', async ({ page }) => {
	test.skip(!password, 'Set E2E_ADMIN_PASSWORD to the password printed by the seed');
	await signIn(page, 'owner@motogarage.local');
	await page.getByRole('link', { name: 'Configuración' }).click();
	await expect(page.getByRole('heading', { name: 'Configuración' })).toBeVisible();
	await expect(page.getByLabel('WhatsApp')).toHaveValue('+5492478407084');

	try {
		await saveOwnWhatsApp(page, '+54 9 11 5555-0000');
		await expect(page.getByRole('status')).toHaveText('Contacto guardado');
		await expect(page.getByLabel('WhatsApp')).toHaveValue('+5491155550000');
		await page.goto('/');
		await expect(whatsapp(page)).toHaveAttribute('href', 'https://wa.me/5491155550000?text=Hola%2C%20vengo%20desde%20la%20web');

		await saveOwnWhatsApp(page, '2478 40-7084');
		await expect(page.getByRole('alert')).toHaveText('Ingresá el número con código de país, por ejemplo +54 9 2478 40-7084');
		await expect(page.getByLabel('WhatsApp')).toHaveValue('2478 40-7084');
	} finally {
		// Leave MotoGarage with its real number.
		await saveOwnWhatsApp(page, '+54 9 2478 40-7084');
		await expect(page.getByRole('status')).toHaveText('Contacto guardado');
	}
	await page.goto('/');
	await expect(whatsapp(page)).toHaveAttribute('href', chat);
});

test('operators and finance have no Configuración', async ({ page }) => {
	test.skip(!password, 'Set E2E_ADMIN_PASSWORD to the password printed by the seed');
	for (const email of ['operador@motogarage.local', 'finanzas@motogarage.local']) {
		await signIn(page, email);
		await expect(page.getByRole('link', { name: 'Configuración' })).toHaveCount(0);
		const response = await page.goto('/admin/configuracion');
		expect(response?.status(), email).toBe(403);
		await page.context().clearCookies();
	}
});
