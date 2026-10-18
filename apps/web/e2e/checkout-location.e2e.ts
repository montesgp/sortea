import { expect, test, type Page } from '@playwright/test';

// S6, S7 (feedback 2026-10-18): the buyer picks a country, gets province and city
// suggestions from our GeoNames copy, and can always type a place that is not listed.
// Needs the reference data in the local database: `pnpm db:geo`.

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

async function fillPerson(page: Page) {
	const email = `e2e-geo-${Date.now()}@example.com`;
	await page.getByLabel('Nombre', { exact: true }).fill('Prueba');
	await page.getByLabel('Apellido').fill('Lugares');
	await page.getByLabel('Número', { exact: true }).fill(String(20_000_000 + Math.floor(Math.random() * 9_000_000)));
	await page.getByLabel('Email', { exact: true }).fill(email);
	await page.getByLabel('Repetí el email').fill(email);
}

async function pay(page: Page) {
	await page.getByLabel(/Acepto los/).check();
	await page.getByLabel(/Leí la/).check();
	await page.getByRole('button', { name: /Ir a pagar/ }).click();
	// The order exists once the checkout hands the buyer to the payment.
	await expect(page).toHaveURL(/\/pago-simulado/);
}

const suggestions = (page: Page) => page.locator('#city-options option');

test('an Argentine buyer picks a province and a city from the suggestions', async ({ page }) => {
	await addToCart(page, 'Manual técnico');
	await open(page, '/checkout');
	await fillPerson(page);

	await expect(page.getByLabel('País', { exact: true })).toHaveValue('AR');
	await expect(page.getByText('con datos de GeoNames (CC BY 4.0)')).toBeVisible();
	await page.getByLabel('Provincia', { exact: true }).selectOption('Santa Fe');
	const city = page.getByLabel('Ciudad', { exact: true });
	await city.pressSequentially('ros');
	// Narrowed to Santa Fe: Rosario, not Rosario del Tala (Entre Ríos).
	await expect(suggestions(page).first()).toHaveAttribute('value', 'Rosario');
	await expect(suggestions(page).filter({ hasText: 'Rosario del Tala' })).toHaveCount(0);
	await city.fill((await suggestions(page).first().getAttribute('value'))!);

	await pay(page);
});

test('cities are found without accents, and a place that is not listed is typed as is', async ({ page }) => {
	await addToCart(page, 'Manual técnico');
	await open(page, '/checkout');
	await fillPerson(page);

	const city = page.getByLabel('Ciudad', { exact: true });
	await city.pressSequentially('rio cuar');
	// Without a province the suggestion names it, so homonyms can be told apart.
	await expect(suggestions(page).filter({ hasText: 'Río Cuarto, Córdoba' })).toHaveCount(1);

	// Neither the province nor the city are in the list: "other" opens a field to type it.
	const province = page.getByLabel('Provincia', { exact: true });
	await expect(page.getByLabel('Tu provincia, si no está en la lista')).toBeHidden();
	await province.selectOption({ label: 'Otra (la escribo)' });
	await page.getByLabel('Tu provincia, si no está en la lista').fill('Isla Martín García');
	await city.fill('Paraje Sin Nombre');
	await expect(suggestions(page)).toHaveCount(0);
	await expect(page.getByText('¿No aparece? Escribila tal cual.')).toBeVisible();

	await pay(page);
});

test('a buyer from another country gets that country provinces and no home shipping', async ({ page }) => {
	await addToCart(page, 'Remera MotoGarage', 'Talle M');
	await open(page, '/checkout');
	await fillPerson(page);
	const shipping = page.getByLabel(/Envío a domicilio/);
	await expect(shipping).toBeEnabled();

	const country = page.getByLabel('País', { exact: true });
	// Latin America first.
	await expect(country.locator('optgroup').first()).toHaveAttribute('label', 'Latinoamérica');
	await country.selectOption({ label: 'Uruguay' });
	const province = page.getByLabel('Provincia', { exact: true });
	await expect(province.getByRole('option', { name: 'Canelones' })).toHaveCount(1);
	await expect(province.getByRole('option', { name: 'Santa Fe' })).toHaveCount(0);
	await province.selectOption('Canelones');
	await page.getByLabel('Ciudad', { exact: true }).fill('Atlántida');

	await expect(shipping).toBeDisabled();
	await expect(page.getByText('El envío a domicilio es solo dentro de Argentina. Podés retirar tu pedido.')).toBeVisible();
	await expect(page.getByLabel(/Retiro sin cargo/)).toBeChecked();
	await expect(page.getByRole('complementary', { name: 'Resumen del pedido' })).not.toContainText('Envío');

	// Back to Argentina, shipping is offered again.
	await country.selectOption({ label: 'Argentina' });
	await expect(shipping).toBeEnabled();
	await country.selectOption({ label: 'Uruguay' });
	await province.selectOption('Canelones');

	await pay(page);
});

test.describe('without JavaScript', () => {
	test('the location fields still work as plain fields, and shipping abroad is refused by the server', async ({ browser }) => {
		// The cart is filled with JavaScript; the checkout runs without it.
		const withScripts = await browser.newContext();
		const setup = await withScripts.newPage();
		await addToCart(setup, 'Remera MotoGarage', 'Talle M');
		const state = await withScripts.storageState();
		await withScripts.close();

		const context = await browser.newContext({ javaScriptEnabled: false, storageState: state });
		const page = await context.newPage();
		await page.goto('/checkout');
		await fillPerson(page);
		await page.getByLabel('País', { exact: true }).selectOption({ label: 'Chile' });
		// Without JavaScript the list is still Argentina's: the typed field is there for any other place.
		await page.getByLabel('Tu provincia, si no está en la lista').fill('Ñuble');
		await page.getByLabel('Ciudad', { exact: true }).fill('Chillán');
		await page.getByLabel(/Envío a domicilio/).check();
		await page.getByLabel(/Acepto los/).check();
		await page.getByLabel(/Leí la/).check();
		await page.getByRole('button', { name: /Ir a pagar/ }).click();

		await expect(page.getByRole('alert').filter({ hasText: 'El envío a domicilio es solo dentro de Argentina. Elegí retiro o cambiá el país' })).toBeVisible();
		// The page comes back with Chile's own provinces, what the buyer typed, and no shipping.
		await expect(page.getByLabel('País', { exact: true })).toHaveValue('CL');
		await expect(page.getByLabel(/Envío a domicilio/)).toBeDisabled();
		await expect(page.getByLabel('Provincia', { exact: true }).getByRole('option', { name: 'Ñuble' })).toHaveCount(1);
		await expect(page.getByLabel('Tu provincia, si no está en la lista')).toHaveValue('Ñuble');

		await page.getByLabel(/Retiro sin cargo/).check();
		await page.getByLabel(/Acepto los/).check();
		await page.getByLabel(/Leí la/).check();
		await page.getByRole('button', { name: /Ir a pagar/ }).click();
		await expect(page).toHaveURL(/\/pago-simulado/);
		await context.close();
	});
});
