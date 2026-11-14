import { expect, test, type Page } from '@playwright/test';

// Back office polish 2026-11-06: the orders search fits its placeholder and filters by
// creation date (S3); the order detail cards never overflow (S4).
const password = process.env.E2E_ADMIN_PASSWORD;
test.skip(!password, 'Set E2E_ADMIN_PASSWORD to the password printed by the seed');

async function signIn(page: Page) {
	await page.goto('/admin/login?next=/admin/pedidos');
	await page.getByLabel('Email').fill('owner@tallerdemo.local');
	await page.getByLabel('Contraseña').fill(password!);
	await page.getByRole('button', { name: 'Ingresar' }).click();
	await page.waitForURL((url) => url.pathname === '/admin/pedidos');
}

/** Width of the placeholder in the input's own font, against the room inside its padding. */
async function placeholderRoom(page: Page) {
	return page.locator('#q').evaluate((input: HTMLInputElement) => {
		const style = getComputedStyle(input);
		const context = document.createElement('canvas').getContext('2d')!;
		context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
		const room = input.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
		return { text: context.measureText(input.placeholder).width, room, scroll: input.scrollWidth, client: input.clientWidth };
	});
}

for (const width of [1366, 390]) {
	test(`the search field shows its whole placeholder at ${width} px`, async ({ page }) => {
		await page.setViewportSize({ width, height: 900 });
		await signIn(page);
		await expect(page.locator('#q')).toHaveAttribute('placeholder', 'Comprobante, Ana Pérez o ana@…');
		const measured = await placeholderRoom(page);
		expect(measured.text).toBeLessThanOrEqual(measured.room);
		expect(measured.scroll).toBeLessThanOrEqual(measured.client);
	});
}

test('filters orders by Desde and Hasta, keeps them in the URL and refuses a reversed range', async ({ page }) => {
	await signIn(page);
	const all = Number((await page.getByText(/^\d+ pedidos\./).textContent())!.split(' ')[0]);

	await page.getByLabel('Desde').fill('01/01/2000');
	await page.getByLabel('Hasta').fill('31/12/2099');
	await page.getByRole('button', { name: 'Filtrar' }).click();
	await expect(page).toHaveURL(/from=01%2F01%2F2000/);
	await expect(page).toHaveURL(/to=31%2F12%2F2099/);
	await expect(page.getByText(`${all} pedidos.`)).toBeVisible();
	await expect(page.getByLabel('Desde')).toHaveValue('01/01/2000');

	await page.getByLabel('Desde').fill('01/01/2099');
	await page.getByRole('button', { name: 'Filtrar' }).click();
	await expect(page.getByText('0 pedidos.')).toBeVisible();
	await expect(page.getByText('No hay pedidos con esos filtros.')).toBeVisible();

	await page.goto('/admin/pedidos?from=2026-11-02&to=2026-11-01');
	await expect(page.getByRole('alert')).toHaveText('La fecha "Desde" no puede ser posterior a la fecha "Hasta"');
	await expect(page.getByLabel('Desde')).toHaveValue('02/11/2026');

	// Draw room S1: days are typed as dd/mm/aaaa, and one that does not exist is refused in place.
	await page.getByLabel('Desde').fill('31/02/2027');
	await page.getByLabel('Hasta').fill('');
	await page.getByRole('button', { name: 'Filtrar' }).click();
	await expect(page.getByRole('alert')).toHaveText('Desde: La fecha 31/02/2027 no existe');
	await expect(page.getByLabel('Desde')).toHaveValue('31/02/2027');

	await page.getByRole('link', { name: 'Limpiar' }).click();
	await expect(page.getByText(`${all} pedidos.`)).toBeVisible();
});

/** Opens the first paid order that has a Mercado Pago payment; earlier purchase runs leave some. */
async function openOrderWithPayment(page: Page): Promise<boolean> {
	await page.goto('/admin/pedidos?status=paid');
	const links = await page.locator('tbody a').evaluateAll((anchors) => anchors.map((anchor) => (anchor as HTMLAnchorElement).pathname));
	for (const link of links) {
		await page.goto(link);
		if ((await page.locator('.payment-id').count()) > 0) return true;
	}
	return false;
}

for (const width of [1366, 390]) {
	test(`the order detail cards do not overflow at ${width} px`, async ({ page }) => {
		await page.setViewportSize({ width, height: 900 });
		await signIn(page);
		test.skip(!(await openOrderWithPayment(page)), 'No paid order with a Mercado Pago payment in the local database');
		// The owner's case: an id without spaces, longer than the card.
		await page.locator('.payment-id').first().evaluate((node) => (node.textContent = '#ORDSIMA3176742205709994E859D03ORDSIMA3176742205709994E859D03'));

		for (const panel of await page.locator('.grid > .panel').all()) {
			const box = await panel.evaluate((node) => ({ scroll: node.scrollWidth, client: node.clientWidth }));
			expect(box.scroll).toBeLessThanOrEqual(box.client);
		}
		const card = page.locator('.panel', { has: page.getByRole('heading', { name: 'Pagos de Mercado Pago' }) });
		const cardBox = (await card.boundingBox())!;
		const amount = (await card.locator('.lines li .money').first().boundingBox())!;
		expect(amount.x).toBeGreaterThanOrEqual(cardBox.x);
		expect(amount.x + amount.width).toBeLessThanOrEqual(cardBox.x + cardBox.width);
		await expect(page.locator('.payment-id').first()).toHaveAttribute('title', /.+/);
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
	});
}
