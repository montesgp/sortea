import { expect, test, type Locator, type Page } from '@playwright/test';

// S4 (feedback 2026-10-17): every product card shares one layout; a product
// with several variants opens a chooser to pick the size and quantity, and
// can add another size without leaving it.

async function open(page: Page, path: string) {
	await page.goto(path, { waitUntil: 'networkidle' });
}

/** A marker that a full page load would erase. */
async function markWindow(page: Page) {
	await page.evaluate(() => ((window as unknown as { __kept: boolean }).__kept = true));
}

async function expectSameDocument(page: Page) {
	expect(await page.evaluate(() => (window as unknown as { __kept?: boolean }).__kept)).toBe(true);
}

async function box(locator: Locator) {
	const rect = await locator.boundingBox();
	expect(rect, 'element is rendered').not.toBeNull();
	return rect!;
}

const headerCount = (page: Page, count: number) =>
	page
		.locator('header')
		.getByRole('link', { name: `Carrito, ${count} ${count === 1 ? 'producto' : 'productos'}`, exact: true })
		.filter({ hasText: String(count) });

const shirtCard = (page: Page) => page.getByRole('article').filter({ hasText: 'Remera MotoGarage' });
const chooser = (page: Page) => page.getByRole('dialog', { name: 'Remera MotoGarage' });
const amount = (text: string | null) => Number((text ?? '').replace(/\D/g, ''));

for (const width of [1366, 390]) {
	test(`every shop card has the same height and button row at ${width}px`, async ({ page }) => {
		await page.setViewportSize({ width, height: 900 });
		await open(page, '/tienda');
		const cards = page.locator('#productos article');
		const total = await cards.count();
		expect(total).toBeGreaterThan(1);
		// No card carries a size picker of its own.
		await expect(cards.getByRole('combobox')).toHaveCount(0);
		await expect(cards.getByRole('radio')).toHaveCount(0);

		const rows = [];
		for (let index = 0; index < total; index++) {
			const card = await box(cards.nth(index));
			const button = await box(cards.nth(index).getByRole('button', { name: 'Agregar al carrito' }));
			const price = await box(cards.nth(index).locator('.price'));
			rows.push({ height: card.height, buttonTop: button.y - card.y, buttonHeight: button.height, buttonWidth: button.width, priceTop: price.y - card.y });
		}
		for (const row of rows) {
			for (const key of ['height', 'buttonTop', 'buttonHeight', 'buttonWidth', 'priceTop'] as const) {
				expect(Math.abs(row[key] - rows[0]![key]), key).toBeLessThanOrEqual(1);
			}
		}
	});
}

test('the shirt opens a chooser that adds two sizes with their quantities without reloading', async ({ page, context }) => {
	await context.clearCookies();
	await open(page, '/tienda');
	await markWindow(page);
	const trigger = shirtCard(page).getByRole('button', { name: 'Agregar al carrito' });
	await expect(trigger).toHaveAttribute('aria-haspopup', 'dialog');
	await trigger.click();

	const dialog = chooser(page);
	await expect(dialog).toBeVisible();
	await expect(page).toHaveURL(/\/tienda$/);
	const unit = amount(await dialog.getByText(/c\/u$/).textContent());
	expect(unit).toBeGreaterThan(0);

	await dialog.getByRole('radio', { name: 'Talle M' }).check();
	const quantity = dialog.getByRole('spinbutton', { name: 'Cantidad' });
	// Bounded by the variant's limit per order, as in the cart.
	await expect(quantity).toHaveAttribute('max', '5');
	await quantity.fill('2');
	await expect(dialog.locator('.preview')).toHaveText(new RegExp(`${(unit * 2).toLocaleString('es-AR').replace(/\./g, '\\.')}$`));
	await dialog.getByRole('button', { name: 'Agregar', exact: true }).click();
	await expect(dialog.getByRole('status')).toHaveText('Agregaste 2 × Talle M al carrito.');
	await expect(headerCount(page, 2)).toBeVisible();

	await dialog.getByRole('radio', { name: 'Talle L' }).check();
	await quantity.fill('1');
	await dialog.getByRole('button', { name: 'Agregar', exact: true }).click();
	await expect(dialog.getByRole('status')).toHaveText('Agregaste 1 × Talle L al carrito.');
	await expect(headerCount(page, 3)).toBeVisible();
	await expect(dialog.getByRole('link', { name: 'Ir al carrito' })).toBeVisible();
	await expect(dialog.getByRole('button', { name: 'Seguir comprando' })).toBeVisible();

	// The server refuses more than the limit per order and the chooser says why.
	await dialog.getByRole('radio', { name: 'Talle M' }).check();
	await quantity.fill('4');
	await dialog.getByRole('button', { name: 'Agregar', exact: true }).click();
	await expect(dialog.getByRole('alert')).toHaveText('Podés llevar hasta 5 por compra. Ya tenés 2 en el carrito.');
	await expect(headerCount(page, 3)).toBeVisible();

	await page.keyboard.press('Escape');
	await expect(dialog).toBeHidden();
	await expect(trigger).toBeFocused();
	await expect(page).toHaveURL(/\/tienda$/);
	await expectSameDocument(page);

	await trigger.click();
	await chooser(page).getByRole('link', { name: 'Ir al carrito' }).click();
	await expect(page).toHaveURL(/\/carrito$/);
	await expectSameDocument(page);
	const lines = page.getByRole('region', { name: 'Productos en tu carrito' });
	await expect(lines.getByRole('listitem')).toHaveCount(2);
	await expect(page.getByLabel('Cantidad de Remera MotoGarage · Talle M')).toHaveValue('2');
	await expect(page.getByLabel('Cantidad de Remera MotoGarage · Talle L')).toHaveValue('1');
});

test('the chooser closes with its buttons and gives focus back to the card', async ({ page }) => {
	await open(page, '/tienda');
	const trigger = shirtCard(page).getByRole('button', { name: 'Agregar al carrito' });
	await trigger.click();
	await expect(chooser(page)).toBeVisible();
	await chooser(page).getByRole('button', { name: 'Cerrar' }).click();
	await expect(chooser(page)).toBeHidden();
	await expect(trigger).toBeFocused();

	await trigger.click();
	await chooser(page).getByRole('button', { name: 'Seguir comprando' }).click();
	await expect(chooser(page)).toBeHidden();
	await expect(trigger).toBeFocused();
});

test('a product with a single variant still goes straight to the cart', async ({ page, context }) => {
	await context.clearCookies();
	await open(page, '/tienda');
	await markWindow(page);
	await page.getByRole('article').filter({ hasText: 'Checklist de viaje' }).getByRole('button', { name: 'Agregar al carrito' }).click();
	await expect(page).toHaveURL(/\/carrito$/);
	await expect(page.getByRole('dialog')).toHaveCount(0);
	await expect(page.getByLabel('Cantidad de Checklist de viaje')).toHaveValue('1');
	await expect(headerCount(page, 1)).toBeVisible();
	await expectSameDocument(page);
});

test.describe('without JavaScript', () => {
	test.use({ javaScriptEnabled: false });

	test('the shirt card leads to a page to choose the size and quantity', async ({ page, context }) => {
		await context.clearCookies();
		await page.goto('/tienda');
		await shirtCard(page).getByRole('button', { name: 'Agregar al carrito' }).click();
		await expect(page).toHaveURL(/\/tienda\/remera/);
		await expect(page.getByRole('heading', { name: 'Remera MotoGarage' })).toBeVisible();
		await page.getByRole('radio', { name: 'Talle L' }).check();
		await page.getByRole('spinbutton', { name: 'Cantidad' }).fill('2');
		await page.getByRole('button', { name: 'Agregar', exact: true }).click();
		await expect(page).toHaveURL(/\/carrito$/);
		await expect(page.getByLabel('Cantidad de Remera MotoGarage · Talle L')).toHaveValue('2');
	});
});
