import { expect, test, type Page } from '@playwright/test';
import { declareAdultIfAsked } from './checkout-consents';

// S7 (feedback 2026-10-16): every checkout asks the buyer's province and city,
// and shipping goes there instead of asking them again.

async function open(page: Page, path: string) {
	await page.goto(path, { waitUntil: 'networkidle' });
}

async function addToCart(page: Page, product: string, option?: string) {
	await open(page, '/tienda');
	const card = page.getByRole('article').filter({ hasText: product });
	await card.getByRole('button', { name: 'Agregar al carrito' }).click();
	if (option) {
		const chooser = page.getByRole('dialog', { name: product });
		await chooser.getByRole('radio', { name: option }).check();
		await chooser.getByRole('button', { name: 'Agregar', exact: true }).click();
		await expect(chooser.getByRole('status')).toContainText('Agregaste');
		await chooser.getByRole('link', { name: 'Ir al carrito' }).click();
	}
	await expect(page).toHaveURL(/\/carrito$/);
	await page.waitForLoadState('networkidle');
}

async function fillBuyer(page: Page, location: { province: string; city: string }) {
	const email = `e2e-location-${Date.now()}@example.com`;
	await page.getByLabel('Nombre', { exact: true }).fill('Prueba');
	await page.getByLabel('Apellido').fill('Ubicación');
	await page.getByLabel('Número', { exact: true }).fill(String(20_000_000 + Math.floor(Math.random() * 9_000_000)));
	await page.getByLabel('Email', { exact: true }).fill(email);
	await page.getByLabel('Repetí el email').fill(email);
	await page.getByLabel('Provincia', { exact: true }).selectOption(location.province);
	await page.getByLabel('Ciudad', { exact: true }).fill(location.city);
}

for (const width of [1366, 390]) {
	test(`a digital checkout asks province and city, says what is missing under each and clears it at ${width}px`, async ({ page }) => {
		await page.setViewportSize({ width, height: 900 });
		await addToCart(page, 'Manual técnico');
		await open(page, '/checkout');

		const province = page.getByLabel('Provincia', { exact: true });
		const city = page.getByLabel('Ciudad', { exact: true });
		// Argentina comes first; its 24 jurisdictions are listed, plus "other" to type one (S6, S7), with nothing chosen up front.
		await expect(page.getByLabel('País', { exact: true })).toHaveValue('AR');
		await expect(province.locator('option:not([value=""]):not([value="__otra__"])')).toHaveCount(24);
		await expect(province.getByRole('option', { name: 'Ciudad Autónoma de Buenos Aires' })).toHaveCount(1);
		await expect(province.getByRole('option', { name: 'Otra (la escribo)' })).toHaveCount(1);
		await expect(province).toHaveValue('');

		await page.getByRole('button', { name: /Ir a pagar/ }).click();
		await expect(page.getByText('Revisá los datos marcados')).toBeVisible();
		await page.waitForLoadState('networkidle');
		await expect(province).toHaveAttribute('aria-invalid', 'true');
		await expect(province).toHaveAccessibleDescription('Elegí tu provincia');
		await expect(city).toHaveAttribute('aria-invalid', 'true');
		await expect(city).toHaveAccessibleDescription('Ingresá tu ciudad');

		// Each message sits right under its own field.
		for (const [field, message] of [[province, 'Elegí tu provincia'], [city, 'Ingresá tu ciudad']] as const) {
			const fieldBox = (await field.boundingBox())!;
			const errorBox = (await page.getByText(message).boundingBox())!;
			expect(errorBox.y).toBeGreaterThanOrEqual(fieldBox.y + fieldBox.height);
			expect(errorBox.y - (fieldBox.y + fieldBox.height)).toBeLessThan(24);
			expect(Math.abs(errorBox.x - fieldBox.x)).toBeLessThan(4);
		}

		await province.selectOption('Santa Fe');
		await expect(page.getByText('Elegí tu provincia')).toBeHidden();
		await expect(province).toHaveAttribute('aria-invalid', 'false');
		await expect(page.getByText('Ingresá tu ciudad')).toBeVisible();
		await city.fill('Rosario');
		await expect(page.getByText('Ingresá tu ciudad')).toBeHidden();
		await expect(city).toHaveAttribute('aria-invalid', 'false');
	});
}

test('shipping goes to the buyer city and province, asks street and postal code, and reaches the payment', async ({ page }) => {
	await addToCart(page, 'Remera MotoGarage', 'Talle M');
	await open(page, '/checkout');
	await page.getByLabel(/Envío a domicilio/).check();

	// City and province are asked once, in the buyer data.
	await expect(page.getByLabel('Localidad', { exact: true })).toHaveCount(0);
	await expect(page.getByLabel('Provincia', { exact: true })).toHaveCount(1);
	const shipping = page.getByRole('group', { name: 'Entrega' });
	await expect(shipping).toContainText('Completá tu provincia y ciudad en Tus datos');

	await fillBuyer(page, { province: 'Buenos Aires', city: 'Arrecifes' });
	await expect(shipping).toContainText('Enviamos a Arrecifes, Buenos Aires');

	await page.getByLabel(/Acepto los/).check();
	await page.getByLabel(/Leí la/).check();
	await declareAdultIfAsked(page);
	await page.getByRole('button', { name: /Ir a pagar/ }).click();
	await expect(page.getByText('Revisá los datos marcados')).toBeVisible();
	await expect(page.locator('main .field .error')).toHaveCount(2);
	await expect(page.getByLabel('Calle y número', { exact: true })).toHaveAccessibleDescription('Completá este dato');
	await expect(page.getByLabel('Código postal', { exact: true })).toHaveAccessibleDescription('Completá este dato');
	// The location survives the failed submit and still names the destination.
	await expect(page.getByLabel('Provincia', { exact: true })).toHaveValue('Buenos Aires');
	await expect(page.getByRole('group', { name: 'Entrega' })).toContainText('Enviamos a Arrecifes, Buenos Aires');

	await page.getByLabel('Calle y número', { exact: true }).fill('Av. Siempreviva 742');
	await page.getByLabel('Código postal', { exact: true }).fill('2740');
	await page.getByLabel(/Acepto los/).check();
	await page.getByLabel(/Leí la/).check();
	await declareAdultIfAsked(page);
	await page.getByRole('button', { name: /Ir a pagar/ }).click();
	await expect(page.getByRole('heading', { name: 'Simulador de pagos' })).toBeVisible();
	const reference = /Orden (\S+)/.exec((await page.getByText(/^Orden /).textContent()) ?? '')![1]!;

	// The organization sees where to deliver; seeded accounts share the password printed by the seed.
	const password = process.env.E2E_ADMIN_PASSWORD;
	test.skip(!password, 'Set E2E_ADMIN_PASSWORD to check the admin view');
	await page.goto('/admin/login');
	await page.getByLabel('Email').fill('owner@motogarage.local');
	await page.getByLabel('Contraseña').fill(password!);
	await page.getByRole('button', { name: 'Ingresar' }).click();
	await expect(page.getByRole('heading', { name: 'Resumen' })).toBeVisible();
	await page.goto(`/admin/pedidos?q=${encodeURIComponent(reference)}`);
	const row = page.getByRole('row').filter({ hasText: reference });
	await expect(row).toContainText('Buenos Aires');
	await row.getByRole('link', { name: reference }).click();
	const buyer = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Comprador' }) });
	await expect(buyer.locator('div').filter({ has: page.getByText('Ubicación', { exact: true }) })).toContainText('Arrecifes, Buenos Aires');
	await expect(buyer).toContainText('Av. Siempreviva 742, Arrecifes, Buenos Aires, 2740');
});
