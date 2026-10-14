import { expect, test, type Browser, type Page } from '@playwright/test';

// Seeded local accounts share one password (SEED_ADMIN_PASSWORD in .env).
const password = process.env.E2E_ADMIN_PASSWORD;
test.skip(!password, 'Set E2E_ADMIN_PASSWORD to the password printed by the seed');

async function openDashboard(page: Page) {
	await page.goto('/admin/login');
	await page.getByLabel('Email').fill('owner@motogarage.local');
	await page.getByLabel('Contraseña').fill(password!);
	await page.getByRole('button', { name: 'Ingresar' }).click();
	await expect(page.getByRole('heading', { name: 'Resumen' })).toBeVisible();
}

/** A guest in a separate browser context buys and pays; returns the order reference. */
async function guestPurchase(browser: Browser, baseURL: string): Promise<string> {
	const context = await browser.newContext({ baseURL });
	const page = await context.newPage();
	const email = `live-${Date.now()}@example.com`;
	await page.goto('/tienda');
	await page.getByRole('article').filter({ hasText: 'Manual técnico' }).getByRole('button', { name: 'Agregar al carrito' }).click();
	await page.getByRole('link', { name: 'Continuar con la compra' }).click();
	await page.getByLabel('Nombre', { exact: true }).fill('Vivo');
	await page.getByLabel('Apellido').fill('Prueba');
	await page.getByLabel('Número').fill(String(20_000_000 + Math.floor(Math.random() * 9_000_000)));
	await page.getByLabel('Email', { exact: true }).fill(email);
	await page.getByLabel('Repetí el email').fill(email);
	await page.getByLabel(/Acepto los/).check();
	await page.getByLabel(/Leí la/).check();
	await page.getByRole('button', { name: /Ir a pagar/ }).click();
	await page.getByRole('button', { name: 'Aprobar pago' }).click();
	await expect(page.getByRole('heading', { name: /compra está confirmada/ })).toBeVisible({ timeout: 20_000 });
	const reference = (await page.locator('.code').first().textContent())!.trim();
	await context.close();
	return reference;
}

test('the dashboard shows a new paid order without reloading (FR-OPS-02)', async ({ page, browser, baseURL }) => {
	await openDashboard(page);
	await expect(page.getByTestId('live-status')).toHaveText('En vivo', { timeout: 15_000 });
	let reloaded = false;
	page.on('framenavigated', (frame) => {
		if (frame === page.mainFrame()) reloaded = true;
	});

	const reference = await guestPurchase(browser, baseURL!);
	await expect(page.getByText(reference)).toBeVisible({ timeout: 10_000 });
	expect(reloaded).toBe(false);
});

test('the dashboard catches up after losing its connection (AC-04)', async ({ page, browser, baseURL }) => {
	// Chromium's offline mode does not cut a stream that is already open, so the
	// drop is staged: the first stream ends at once, reconnections fail with a
	// network error, and then the network comes back. Everything after that is
	// the real browser reconnection and the real API replay.
	let network: 'first' | 'down' | 'up' = 'first';
	await page.route('**/admin/eventos**', async (route) => {
		if (network === 'first') {
			network = 'down';
			return route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: 'retry: 1000\n\n' });
		}
		if (network === 'down') return route.abort('internetdisconnected');
		return route.continue();
	});
	await openDashboard(page);
	await expect(page.getByTestId('live-status')).toHaveText('Reconectando…', { timeout: 15_000 });

	const reference = await guestPurchase(browser, baseURL!);
	await page.waitForTimeout(1_500);
	await expect(page.getByText(reference)).toHaveCount(0);

	network = 'up';
	await expect(page.getByText(reference)).toBeVisible({ timeout: 20_000 });
	await expect(page.getByTestId('live-status')).toHaveText('En vivo');
});
