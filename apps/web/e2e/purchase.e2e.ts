import { expect, test, type Page } from '@playwright/test';

const MAILPIT = process.env.MAILPIT_URL ?? 'http://127.0.0.1:54324';

async function waitForEmail(page: Page, to: string, subject: RegExp) {
	for (let attempt = 0; attempt < 30; attempt++) {
		const response = await page.request.get(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${to}`)}`);
		const body = (await response.json()) as { messages: { ID: string; Subject: string }[] };
		const message = body.messages.find((candidate) => subject.test(candidate.Subject));
		if (message) {
			const detail = await page.request.get(`${MAILPIT}/api/v1/message/${message.ID}`);
			return (await detail.json()) as { Subject: string; HTML: string; Text: string };
		}
		await page.waitForTimeout(1000);
	}
	throw new Error(`No email for ${to} matching ${subject}`);
}

test('home shows the brand and routes to the campaign and the shop', async ({ page }) => {
	await page.goto('/');
	await expect(page.getByRole('heading', { level: 1 })).toContainText(/motos/i);
	await expect(page.getByRole('link', { name: 'Ver la campaña' }).first()).toBeVisible();
	await page.getByRole('navigation', { name: 'Principal' }).getByRole('link', { name: 'Tienda' }).click();
	await expect(page).toHaveURL(/\/tienda$/);
});

test('guest buys the manual, pays and receives the files by email', async ({ page }) => {
	const email = `e2e-${Date.now()}@example.com`;
	const documentNumber = String(20_000_000 + Math.floor(Math.random() * 9_000_000));

	await page.goto('/tienda');
	await page.getByRole('article').filter({ hasText: 'Manual técnico' }).getByRole('button', { name: 'Agregar al carrito' }).click();
	await expect(page).toHaveURL(/\/carrito$/);

	// Extras are offered but never pre-added.
	await expect(page.getByRole('heading', { name: '¿Querés sumar algo?' })).toBeVisible();
	await expect(page.locator('.lines li')).toHaveCount(1);

	await page.getByRole('link', { name: 'Continuar con la compra' }).click();
	await page.getByLabel('Nombre', { exact: true }).fill('Prueba');
	await page.getByLabel('Apellido').fill('Automática');
	await page.getByLabel('Número').fill(documentNumber);
	await page.getByLabel('Email', { exact: true }).fill(email);
	await page.getByLabel('Repetí el email').fill(email);
	await page.getByLabel('Provincia', { exact: true }).selectOption('Buenos Aires');
	await page.getByLabel('Ciudad', { exact: true }).fill('Arrecifes');
	await expect(page.getByLabel(/Quiero recibir novedades/)).not.toBeChecked();
	await page.getByLabel(/Acepto los/).check();
	await page.getByLabel(/Leí la/).check();
	await page.getByRole('button', { name: /Ir a pagar/ }).click();

	await expect(page.getByRole('heading', { name: 'Simulador de pagos' })).toBeVisible();
	await page.getByRole('button', { name: 'Aprobar pago' }).click();

	await expect(page.getByRole('heading', { name: /compra está confirmada/ })).toBeVisible({ timeout: 20_000 });
	const reference = (await page.locator('.code').first().textContent())!.trim();
	const accessCode = (await page.locator('.code').nth(1).textContent())!.trim();

	const mail = await waitForEmail(page, email, /Compra confirmada/);
	expect(mail.Subject).toContain(reference);
	const link = /\/descargas\/[A-Za-z0-9_-]+/.exec(mail.HTML)?.[0];
	expect(link).toBeTruthy();

	// The receipt opens a lookup limited to this order, with a fresh download link.
	await page.goto('/consulta');
	await page.getByLabel('Comprobante').fill(reference);
	await page.getByLabel('Código de acceso').fill(accessCode);
	await page.getByRole('button', { name: 'Ver esta compra' }).click();
	await expect(page.getByText(reference)).toBeVisible();
	await expect(page.getByRole('button', { name: /Descargar/ })).toBeVisible();
});

test('a document lookup always answers the same way and needs the emailed code', async ({ page }) => {
	await page.goto('/consulta');
	await page.getByLabel('Número').fill('41999888');
	await page.getByRole('button', { name: 'Enviarme un código' }).click();
	await expect(page.getByRole('status')).toContainText('Si el documento tiene compras registradas');
	await page.getByLabel('Código de 6 dígitos').fill('123456');
	await page.getByRole('button', { name: 'Ver mis compras' }).click();
	await expect(page.getByRole('alert')).toContainText(/no es válido/);
});

test('each tenant renders its own theme from the same code (AC-10)', async ({ page }) => {
	await page.goto('/');
	const motoGarage = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim());
	await page.goto(page.url().replace('localhost', 'pista.localhost'));
	const pistaSur = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim());
	expect(motoGarage).not.toBe('');
	expect(pistaSur).not.toBe(motoGarage);
	await expect(page.getByRole('heading', { level: 1 })).toContainText('Pista Sur');
});
