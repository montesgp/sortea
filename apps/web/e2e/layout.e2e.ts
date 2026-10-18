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
	const cart = header.getByRole('link', { name: /^Carrito/ });
	const shop = header.getByRole('link', { name: 'Tienda' });
	expect((await box(toggle)).height).toBe((await box(cart)).height);
	expect((await box(toggle)).height).toBe((await box(shop)).height);
});

// S3: a cart icon instead of the word, with the count in its name and badge.
test('the header cart is an icon named by its count, with a 44px touch target', async ({ page }) => {
	await page.context().clearCookies();
	await page.goto('/tienda');
	const header = page.locator('header');
	const empty = header.getByRole('link', { name: 'Carrito', exact: true });
	await expect(empty).toHaveAttribute('href', '/carrito');
	await expect(empty.locator('svg')).toBeVisible();
	await expect(empty).toHaveText('');

	await page.getByRole('button', { name: 'Agregar al carrito' }).first().click();
	await expect(page).toHaveURL(/\/carrito$/);
	const cart = header.getByRole('link', { name: 'Carrito, 1 producto', exact: true });
	await expect(cart).toHaveText('1');

	// A tap just outside the drawn icon still opens the cart.
	await page.goto('/tienda');
	const icon = await box(header.getByRole('link', { name: /^Carrito/ }));
	expect(Math.max(icon.width, icon.height)).toBeLessThan(44);
	await page.mouse.click(icon.x + icon.width / 2, icon.y + icon.height / 2 - 21);
	await expect(page).toHaveURL(/\/carrito$/);
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

async function signInAs(page: Page, email: string) {
	await page.goto('/admin/login');
	await page.getByLabel('Email').fill(email);
	await page.getByLabel('Contraseña').fill(password!);
	await page.getByRole('button', { name: 'Ingresar' }).click();
	await page.waitForURL((url) => !url.pathname.endsWith('/login'));
}

// Feedback 2026-10-17 S2: the Demo pill used to touch the campaign name.
test('the Demo pill keeps a clear gap from the campaign name', async ({ page }) => {
	test.skip(!password, 'Set E2E_ADMIN_PASSWORD to the password printed by the seed');
	for (const width of [1366, 390]) {
		await page.setViewportSize({ width, height: 900 });
		await signInAs(page, 'owner@motogarage.local');
		await page.goto('/admin/campanas');
		const row = page.getByRole('row').filter({ has: page.locator('.chip', { hasText: 'Demo' }) }).first();
		const name = await box(row.getByRole('link'));
		const pill = await box(row.locator('.chip', { hasText: 'Demo' }));
		const sameLine = pill.y < name.y + name.height && name.y < pill.y + pill.height;
		if (sameLine) expect(pill.x - (name.x + name.width)).toBeGreaterThanOrEqual(6);
		else expect(pill.y - (name.y + name.height)).toBeGreaterThanOrEqual(4);
		await page.context().clearCookies();
	}
});

// Feedback 2026-10-17 S1: the enrolment QR rendered as a broken image pushed to
// the left. Cancelling at the end removes the unverified factor the test created.
test('the two-step QR loads, keeps its natural size and is centered', async ({ page }) => {
	test.skip(!password, 'Set E2E_ADMIN_PASSWORD to the password printed by the seed');
	await page.setViewportSize({ width: 390, height: 844 });
	await signInAs(page, 'owner@pistasur.local');
	await page.goto('/admin/mfa');
	await page.getByRole('button', { name: 'Configurar app de autenticación' }).click();
	const qr = page.getByRole('img', { name: 'Código QR para la app de autenticación' });
	await expect(qr).toBeVisible();

	const image = await qr.evaluate((element: HTMLImageElement) => {
		const style = getComputedStyle(element);
		const frame = ['paddingLeft', 'paddingRight', 'borderLeftWidth', 'borderRightWidth'].reduce((sum, key) => sum + parseFloat(style[key as 'paddingLeft']), 0);
		return { natural: element.naturalWidth, rendered: element.getBoundingClientRect().width - frame };
	});
	expect(image.natural, 'the QR image decodes').toBeGreaterThan(0);
	// Drawn at its own size: no resampling blur.
	expect(image.rendered).toBe(image.natural);

	for (const width of [390, 1366]) {
		await page.setViewportSize({ width, height: 900 });
		// The panel is centered in the page, so centered in the page means centered in the panel.
		const container = await box(page.getByRole('main'));
		const frame = await box(qr);
		expect(Math.abs(frame.x + frame.width / 2 - (container.x + container.width / 2))).toBeLessThanOrEqual(2);
	}

	// Cancelling goes back to the panel (feedback 2026-10-17, round 4) and drops the pending factor.
	await page.getByRole('button', { name: 'Cancelar' }).click();
	await expect(page).toHaveURL(/\/admin$/);
	await page.goto('/admin/mfa');
	await expect(page.getByRole('button', { name: 'Configurar app de autenticación' })).toBeVisible();
});
