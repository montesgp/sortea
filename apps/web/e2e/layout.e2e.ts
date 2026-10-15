import { expect, test, type Locator, type Page } from '@playwright/test';

// Layout regressions reported by the owner (feedback 2026-10-15): boxes that
// belong to the same row must share their top edge and height.
const password = process.env.E2E_ADMIN_PASSWORD;

async function box(locator: Locator) {
	const rect = await locator.boundingBox();
	expect(rect, 'element is rendered').not.toBeNull();
	return rect!;
}

async function expectSameRow(locators: Locator[]) {
	const [first, ...rest] = await Promise.all(locators.map(box));
	for (const other of rest) {
		expect(Math.abs(other.y - first.y)).toBeLessThanOrEqual(1);
		expect(Math.abs(other.height - first.height)).toBeLessThanOrEqual(1);
	}
}

async function addEveryProduct(page: Page) {
	await page.goto('/tienda');
	const count = await page.getByRole('button', { name: 'Agregar al carrito' }).count();
	for (let index = 0; index < count; index++) {
		await page.goto('/tienda');
		await page.getByRole('button', { name: 'Agregar al carrito' }).nth(index).click();
		await page.waitForLoadState('networkidle');
	}
}

test('the theme switch is as tall as the other header controls', async ({ page }) => {
	await page.goto('/tienda');
	const header = page.locator('header');
	const toggle = header.getByRole('button', { name: /Usar tema/ });
	const cart = header.getByRole('link', { name: 'Carrito' });
	const shop = header.getByRole('link', { name: 'Tienda' });
	expect((await box(toggle)).height).toBe((await box(cart)).height);
	expect((await box(toggle)).height).toBe((await box(shop)).height);
});

for (const width of [1366, 390]) {
	test(`every shop card places its price and button the same way at ${width}px`, async ({ page }) => {
		await page.setViewportSize({ width, height: 900 });
		await page.goto('/tienda');
		const cards = page.locator('article.card').filter({ has: page.getByRole('button', { name: 'Agregar al carrito' }) });
		const total = await cards.count();
		expect(total).toBeGreaterThan(1);
		const offsets = [];
		for (let index = 0; index < total; index++) {
			const card = await box(cards.nth(index));
			const price = await box(cards.nth(index).locator('.price'));
			const button = await box(cards.nth(index).getByRole('button', { name: 'Agregar al carrito' }));
			offsets.push({ buttonBottom: Math.round(card.y + card.height - (button.y + button.height)), priceAbove: button.y >= price.y + price.height, buttonWidth: Math.round(button.width) });
		}
		for (const offset of offsets) {
			expect(offset).toEqual(offsets[0]);
			expect(offset.priceAbove).toBe(true);
		}
	});
}

test('checkout: document type and number line up and product names fit on one line', async ({ page }) => {
	await page.setViewportSize({ width: 1366, height: 900 });
	await addEveryProduct(page);
	await page.goto('/checkout');
	await expectSameRow([page.getByLabel('Documento'), page.getByLabel('Número')]);
	await expectSameRow([page.getByText('Documento', { exact: true }), page.getByText('Número', { exact: true })]);

	const summary = page.getByRole('complementary', { name: 'Resumen del pedido' });
	const lines = summary.getByRole('listitem');
	for (let index = 0; index < (await lines.count()); index++) {
		const [name, price] = await Promise.all([box(lines.nth(index).locator('span').first()), box(lines.nth(index).locator('.money'))]);
		expect(name.height).toBeLessThanOrEqual(price.height + 1);
	}
});

test('admin form rows keep labels and controls aligned', async ({ page }) => {
	test.skip(!password, 'Set E2E_ADMIN_PASSWORD to the password printed by the seed');
	await page.setViewportSize({ width: 1366, height: 900 });
	await page.goto('/admin/login');
	await page.getByLabel('Email').fill('owner@motogarage.local');
	await page.getByLabel('Contraseña').fill(password!);
	await page.getByRole('button', { name: 'Ingresar' }).click();
	await expect(page.getByRole('heading', { name: 'Resumen' })).toBeVisible();

	// The slug hint used to stretch the name and type boxes beside it.
	await page.goto('/admin/productos');
	await expectSameRow([page.getByLabel('Nombre'), page.getByLabel('Dirección en la tienda'), page.getByLabel('Tipo')]);

	// A label that wraps to two lines used to push its box below the others.
	await page.getByRole('link', { name: 'Manual técnico MotoGarage' }).click();
	const variant = page.locator('form[action="?/addVariant"]');
	await page.getByText('Agregar variante', { exact: true }).first().click();
	await expectSameRow([variant.getByLabel('Stock'), variant.getByLabel('Máximo por compra'), variant.getByLabel(/A la venta desde/), variant.getByLabel('Hasta')]);

	// Filters: inputs, selects and the submit button share one height.
	await page.goto('/admin/conciliacion');
	await expectSameRow([page.getByLabel('Desde'), page.getByLabel('Hasta'), page.getByRole('button', { name: 'Ver período' })]);
	await expectSameRow([page.getByLabel('Estado'), page.getByLabel('Tipo'), page.getByRole('button', { name: 'Filtrar' })]);
	await page.goto('/admin/pedidos');
	await expectSameRow([page.getByLabel('Comprobante'), page.getByLabel('Estado'), page.getByRole('button', { name: 'Filtrar' })]);
});
