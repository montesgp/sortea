import { expect, test, type Locator, type Page } from '@playwright/test';

// Cart and checkout behavior reported by the owner (feedback 2026-10-15):
// added products and suggestions must not be confused, quantities update
// without a button, adding never reloads the page, and checkout errors
// neither overlap the form nor outlive the fix.

const amount = (text: string | null) => Number((text ?? '').replace(/\D/g, ''));

/** A marker that a full page load would erase. */
async function markWindow(page: Page) {
	await page.evaluate(() => ((window as unknown as { __kept: boolean }).__kept = true));
}

async function expectSameDocument(page: Page) {
	expect(await page.evaluate(() => (window as unknown as { __kept?: boolean }).__kept)).toBe(true);
}

/** Waits until the page's scripts run; a click before that is a plain form post. */
async function open(page: Page, path: string) {
	await page.goto(path, { waitUntil: 'networkidle' });
}

async function addManual(page: Page) {
	await open(page, '/tienda');
	await page.getByRole('article').filter({ hasText: 'Manual técnico' }).getByRole('button', { name: 'Agregar al carrito' }).click();
	await expect(page).toHaveURL(/\/carrito$/);
	await page.waitForLoadState('networkidle');
}

const cartRegion = (page: Page) => page.getByRole('region', { name: 'Productos en tu carrito' });
const suggestions = (page: Page) => page.getByRole('region', { name: '¿Querés sumar algo?' });
const subtotal = (page: Page) => page.getByRole('complementary', { name: 'Resumen' }).locator('dd').first();
/** The summary says so while a change is on its way to the server. */
const settled = (page: Page) => expect(page.getByRole('complementary', { name: 'Resumen' }).getByRole('status')).toHaveText(/lo calcula el servidor/, { timeout: 10_000 });
const headerCount = (page: Page, count: number) => page.locator('header').getByLabel(`${count} productos`);

test('adding from the shop and the home keeps the page loaded and updates the header count', async ({ page }) => {
	await open(page, '/tienda');
	await markWindow(page);
	await page.getByRole('article').filter({ hasText: 'Manual técnico' }).getByRole('button', { name: 'Agregar al carrito' }).click();
	await expect(page).toHaveURL(/\/carrito$/);
	await expect(cartRegion(page).getByRole('listitem')).toHaveCount(1);
	await expect(headerCount(page, 1)).toBeVisible();
	await expectSameDocument(page);

	await open(page, '/');
	await markWindow(page);
	const homeCards = page.getByRole('button', { name: 'Agregar al carrito' });
	test.skip((await homeCards.count()) === 0, 'The home shows no products');
	await homeCards.first().click();
	await expect(page).toHaveURL(/\/carrito$/);
	await expect(headerCount(page, 2)).toBeVisible();
	await expectSameDocument(page);
});

test('cart lines and suggestions are separate regions and suggestions are never preselected', async ({ page }) => {
	await addManual(page);
	await markWindow(page);
	const lines = cartRegion(page).getByRole('listitem');
	await expect(lines).toHaveCount(1);
	await expect(lines.first().getByRole('spinbutton')).toBeVisible();

	const offers = suggestions(page).getByRole('listitem');
	expect(await offers.count()).toBeGreaterThan(0);
	await expect(suggestions(page).getByRole('spinbutton')).toHaveCount(0);
	await expect(cartRegion(page).getByRole('button', { name: 'Agregar' })).toHaveCount(0);
	// The two lists never overlap on screen: suggestions come after the cart lines.
	const [cartBox, offersBox] = await Promise.all([cartRegion(page).boundingBox(), suggestions(page).boundingBox()]);
	expect(offersBox!.y).toBeGreaterThanOrEqual(cartBox!.y + cartBox!.height);

	const before = amount(await subtotal(page).textContent());
	const name = (await offers.first().locator('.name').textContent())!.trim();
	await offers.first().getByRole('button', { name: 'Agregar' }).click();
	await expect(lines).toHaveCount(2);
	await expect(cartRegion(page).getByText(name, { exact: true })).toBeVisible();
	await expect(suggestions(page).getByText(name, { exact: true })).toHaveCount(0);
	await expect.poll(async () => amount(await subtotal(page).textContent())).toBeGreaterThan(before);
	await expect(headerCount(page, 2)).toBeVisible();
	await expectSameDocument(page);
});

test('changing a quantity updates every amount without a button or a reload', async ({ page }) => {
	await addManual(page);
	await markWindow(page);
	const navigations: string[] = [];
	page.on('framenavigated', (frame) => {
		if (frame === page.mainFrame()) navigations.push(frame.url());
	});

	const line = cartRegion(page).getByRole('listitem').first();
	await expect(line.getByRole('button', { name: 'Actualizar' })).toBeHidden();
	const unit = amount(await line.locator('.unit').textContent());
	expect(unit).toBeGreaterThan(0);

	await line.getByRole('spinbutton').fill('3');
	await expect(line.locator('.total')).toHaveText(new RegExp(`${(unit * 3).toLocaleString('es-AR').replace(/\./g, '\\.')}$`));
	await expect.poll(async () => amount(await subtotal(page).textContent())).toBe(unit * 3);
	await expect(headerCount(page, 3)).toBeVisible();
	await expectSameDocument(page);

	// The server recorded it: a fresh load shows the same cart.
	await settled(page);
	expect(navigations.filter((url) => !url.endsWith('/carrito'))).toEqual([]);
	await page.reload();
	await expect(cartRegion(page).getByRole('spinbutton')).toHaveValue('3');
	expect(amount(await subtotal(page).textContent())).toBe(unit * 3);
});

test('the latest quantity wins even when an earlier update answers late', async ({ page }) => {
	await addManual(page);
	let delayed = false;
	const isUpdate = (url: URL) => url.pathname === '/carrito' && url.search === '?/update';
	await page.route(isUpdate, async (route) => {
		if (!delayed) {
			delayed = true;
			await new Promise((resolve) => setTimeout(resolve, 1500));
		}
		await route.continue();
	});
	const line = cartRegion(page).getByRole('listitem').first();
	const unit = amount(await line.locator('.unit').textContent());
	const input = line.getByRole('spinbutton');
	await input.fill('2');
	await expect.poll(() => delayed).toBe(true);
	await input.fill('4');
	await settled(page);
	expect(amount(await subtotal(page).textContent())).toBe(unit * 4);
	await expect(input).toHaveValue('4');

	await page.unroute(isUpdate);
	await page.reload();
	await expect(cartRegion(page).getByRole('spinbutton')).toHaveValue('4');
});

test('removing a line keeps the page loaded', async ({ page }) => {
	await addManual(page);
	await markWindow(page);
	await cartRegion(page).getByRole('button', { name: /Quitar/ }).click();
	await expect(page.getByText('Todavía no agregaste productos.')).toBeVisible();
	await expect(page.locator('header .count')).toHaveCount(0);
	await expectSameDocument(page);
});

test.describe('without JavaScript', () => {
	test.use({ javaScriptEnabled: false });

	test('the update button still changes the quantity', async ({ page }) => {
		await addManual(page);
		const line = cartRegion(page).getByRole('listitem').first();
		const unit = amount(await line.locator('.unit').textContent());
		await line.getByRole('spinbutton').fill('2');
		await line.getByRole('button', { name: 'Actualizar' }).click();
		await expect(cartRegion(page).getByRole('spinbutton')).toHaveValue('2');
		expect(amount(await subtotal(page).textContent())).toBe(unit * 2);
	});
});

function intersects(a: { x: number; y: number; width: number; height: number }, b: typeof a) {
	return a.x < b.x + b.width - 0.5 && b.x < a.x + a.width - 0.5 && a.y < b.y + b.height - 0.5 && b.y < a.y + a.height - 0.5;
}

async function expectApart(error: Locator, others: Locator, minGap = 0) {
	const box = (await error.boundingBox())!;
	for (const other of await others.all()) {
		const rect = await other.boundingBox();
		if (!rect) continue;
		const grown = { x: rect.x - minGap, y: rect.y - minGap, width: rect.width + 2 * minGap, height: rect.height + 2 * minGap };
		expect(intersects(box, grown), `${await error.textContent()} clears ${await other.evaluate((el) => el.tagName + ' ' + (el.getAttribute('name') ?? el.textContent?.trim().slice(0, 30)))}`).toBe(false);
	}
}

for (const width of [1366, 390]) {
	test(`checkout errors stay clear of the form and the summary and go away once fixed at ${width}px`, async ({ page }) => {
		await page.setViewportSize({ width, height: 900 });
		await addManual(page);
		await page.goto('/checkout');
		await page.getByLabel('Email', { exact: true }).fill('ana@example.com');
		await page.getByLabel('Repetí el email').fill('otra@example.com');
		await page.getByRole('button', { name: /Ir a pagar/ }).click();
		await expect(page.getByText('Revisá los datos marcados')).toBeVisible();

		const main = page.locator('main');
		const summary = page.getByRole('complementary', { name: 'Resumen del pedido' });
		const controls = main.locator('input:not([type=hidden]), select, label, legend');
		const errors = main.locator('.error');
		expect(await errors.count()).toBeGreaterThan(3);
		for (const error of await errors.all()) {
			await expectApart(error, controls);
			await expectApart(error, summary, 8);
		}
		await expectApart(page.getByRole('alert'), summary, 8);
		await expectApart(page.getByRole('alert'), main.locator('legend'), 8);

		const firstName = page.getByLabel('Nombre', { exact: true });
		await firstName.fill('Ana');
		await expect(page.getByText('Ingresá tu nombre')).toBeHidden();
		await expect(firstName).toHaveAttribute('aria-invalid', 'false');
		await expect(page.getByText('Ingresá tu apellido')).toBeVisible();

		await page.getByLabel('Repetí el email').fill('ana@example.com');
		await expect(page.getByText('Los emails no coinciden')).toBeHidden();

		await page.getByLabel(/Acepto los/).check();
		await expect(page.getByText('Necesitamos que aceptes los términos para vender')).toBeHidden();
		await expect(page.getByText('Necesitamos que leas la política de privacidad')).toBeVisible();
	});
}

test('every shipping field the server rejects says so under the field and clears once edited', async ({ page }) => {
	await open(page, '/tienda');
	await page.getByRole('article').filter({ hasText: 'Remera MotoGarage' }).getByRole('button', { name: 'Agregar al carrito' }).click();
	await expect(page).toHaveURL(/\/carrito$/);
	await open(page, '/checkout');
	await page.getByLabel(/Envío a domicilio/).check();
	await page.getByRole('button', { name: /Ir a pagar/ }).click();
	await expect(page.getByText('Revisá los datos marcados')).toBeVisible();
	await page.waitForLoadState('networkidle');

	const fields = ['Calle y número', 'Localidad', 'Provincia', 'Código postal'];
	for (const label of fields) {
		const field = page.getByLabel(label, { exact: true });
		await expect(field).toHaveAttribute('aria-invalid', 'true');
		await expect(field).toHaveAccessibleDescription('Completá este dato');
	}
	await expect(page.locator('main .error').filter({ hasText: 'Completá este dato' })).toHaveCount(fields.length);

	await page.getByLabel('Localidad', { exact: true }).fill('Arrecifes');
	await expect(page.getByLabel('Localidad', { exact: true })).toHaveAttribute('aria-invalid', 'false');
	await expect(page.locator('main .error').filter({ hasText: 'Completá este dato' })).toHaveCount(fields.length - 1);
	await expect(page.getByLabel('Provincia', { exact: true })).toHaveAccessibleDescription('Completá este dato');
});

test('a product with several variants lets the buyer choose one, and the cart names product and variant', async ({ page }) => {
	await open(page, '/tienda');
	const card = page.getByRole('article').filter({ hasText: 'Remera MotoGarage' });
	await expect(card.getByRole('img')).toHaveCount(0); // decorative image, hidden from the accessibility tree
	await card.getByLabel('Opción').selectOption({ label: 'Talle M' });
	await card.getByRole('button', { name: 'Agregar al carrito' }).click();
	await expect(page).toHaveURL(/\/carrito$/);
	const lines = page.getByRole('region', { name: 'Productos en tu carrito' });
	await expect(lines).toContainText('Remera MotoGarage · Talle M');
	await expect(lines).not.toContainText('Talle S');
});
