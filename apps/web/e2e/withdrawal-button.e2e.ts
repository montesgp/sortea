import { expect, test, type BrowserContext, type Page } from '@playwright/test';

// Owner feedback 2026-10-28 S12 (Res. 424/2020): a "Botón de arrepentimiento" on
// every public page leads, without registration, to a page that opens WhatsApp
// with a prepared message (MotoGarage seeds +54 9 2478 40-7084).
const chat =
	'https://wa.me/5492478407084?text=Hola%2C%20quiero%20ejercer%20mi%20derecho%20de%20arrepentimiento.%20Pedido%3A%20MG-7K2Q9XHD.%20Nombre%3A%20Ana%20P%C3%A9rez.';

const button = (page: Page) => page.locator('footer').getByRole('link', { name: 'Botón de arrepentimiento' });

/** WhatsApp is outside the test: answer its page locally and keep the URL the site opened. */
async function stubWhatsApp(context: BrowserContext) {
	await context.route('https://wa.me/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<p>WhatsApp</p>' }));
}

test('every public page links to the withdrawal page from the footer', async ({ page }) => {
	for (const path of ['/', '/tienda', '/sorteos/tornado-300', '/sorteos/tornado-300/transparencia']) {
		await page.goto(path);
		const link = button(page);
		await expect(link, path).toHaveCount(1);
		await expect(link).toHaveAttribute('href', '/arrepentimiento');
		await link.scrollIntoViewIfNeeded();
		await expect(link).toBeVisible();
	}
	await button(page).click();
	await expect(page).toHaveURL(/\/arrepentimiento$/);
	await expect(page.getByRole('heading', { level: 1, name: 'Botón de arrepentimiento' })).toBeVisible();
});

test('the page opens without login and explains the right', async ({ page }) => {
	await page.context().clearCookies();
	const response = await page.goto('/arrepentimiento');
	expect(response?.status()).toBe(200);
	await expect(page).toHaveURL(/\/arrepentimiento$/);
	const main = page.getByRole('main');
	await expect(main).toContainText('10 días corridos');
	await expect(main).toContainText('sin costo');
	await expect(main).toContainText('código de seguimiento');
	await expect(main).toContainText('24 horas');
	await expect(page.getByRole('button', { name: 'Solicitar el arrepentimiento por WhatsApp' })).toBeVisible();
});

test('the button opens WhatsApp with the prepared message', async ({ page }) => {
	await stubWhatsApp(page.context());
	await page.goto('/arrepentimiento');
	// Once the page is interactive the button is the WhatsApp link itself.
	const link = page.getByRole('link', { name: 'Solicitar el arrepentimiento por WhatsApp' });
	await expect(link).toHaveAttribute('href', 'https://wa.me/5492478407084?text=Hola%2C%20quiero%20ejercer%20mi%20derecho%20de%20arrepentimiento.');

	// A wrong receipt code is refused under its field and WhatsApp does not open.
	await page.getByLabel('Comprobante').fill('7K2Q9XHD');
	await link.click();
	await expect(page.getByText('Revisá el comprobante: tiene el formato XX-XXXXXXXX')).toBeVisible();
	await expect(page).toHaveURL(/\/arrepentimiento$/);
	expect(page.context().pages()).toHaveLength(1);

	await page.getByLabel('Comprobante').fill(' mg-7k2q9xhd ');
	await page.getByLabel('Nombre y apellido').fill('Ana Pérez');
	await expect(link).toHaveAttribute('href', chat);
	await expect(link).toHaveAttribute('target', '_blank');
	const [chatPage] = await Promise.all([page.waitForEvent('popup'), link.click()]);
	await expect(chatPage).toHaveURL(chat);
	await expect(page.getByText('Revisá el comprobante')).toHaveCount(0);
});

test('without JavaScript the same form opens WhatsApp and refuses a wrong receipt code', async ({ browser }) => {
	const context = await browser.newContext({ javaScriptEnabled: false });
	try {
		await stubWhatsApp(context);
		const page = await context.newPage();
		await page.goto('/arrepentimiento');

		await page.getByLabel('Comprobante').fill('7K2Q9XHD');
		await page.getByLabel('Nombre y apellido').fill('Ana Pérez');
		await page.getByRole('button', { name: 'Solicitar el arrepentimiento por WhatsApp' }).click();
		await expect(page).toHaveURL(/\/arrepentimiento/);
		await expect(page.getByText('Revisá el comprobante: tiene el formato XX-XXXXXXXX, como figura al terminar la compra. Si no lo tenés, dejalo vacío.')).toBeVisible();
		// What was typed stays in the fields to be corrected.
		await expect(page.getByLabel('Comprobante')).toHaveValue('7K2Q9XHD');
		await expect(page.getByLabel('Nombre y apellido')).toHaveValue('Ana Pérez');

		await page.getByLabel('Comprobante').fill('MG-7K2Q9XHD');
		await page.getByRole('button', { name: 'Solicitar el arrepentimiento por WhatsApp' }).click();
		const ready = page.getByRole('link', { name: 'Abrir WhatsApp con el mensaje' });
		await expect(ready).toHaveAttribute('href', chat);
		const [chatPage] = await Promise.all([page.waitForEvent('popup'), ready.click()]);
		await expect(chatPage).toHaveURL(chat);
	} finally {
		await context.close();
	}
});
