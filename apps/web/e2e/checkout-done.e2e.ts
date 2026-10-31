import { expect, test, type Page } from '@playwright/test';
import { declareAdultIfAsked } from './checkout-consents';

// Owner feedback 2026-10-30: once the buyer went to pay, the browser's Back
// button shows the checkout again. It must not be usable for a second order:
// the form is locked with a notice, a link to the purchase and a way to keep
// shopping, and the server refuses a resubmit of that page.

const DONE = 'Esta compra ya se procesó.';

async function toCheckout(page: Page) {
	await page.goto('/tienda', { waitUntil: 'networkidle' });
	await page.getByRole('article').filter({ hasText: 'Manual técnico' }).getByRole('button', { name: 'Agregar al carrito' }).click();
	await expect(page).toHaveURL(/\/carrito$/);
	await page.goto('/checkout', { waitUntil: 'networkidle' });
}

async function fillBuyer(page: Page) {
	const email = `e2e-done-${Date.now()}@example.com`;
	await page.getByLabel('Nombre', { exact: true }).fill('Prueba');
	await page.getByLabel('Apellido').fill('Atrás');
	await page.getByLabel('Número').fill(String(20_000_000 + Math.floor(Math.random() * 9_000_000)));
	await page.getByLabel('Email', { exact: true }).fill(email);
	await page.getByLabel('Repetí el email').fill(email);
	await page.getByLabel('Provincia', { exact: true }).selectOption('Buenos Aires');
	await page.getByLabel('Ciudad', { exact: true }).fill('Arrecifes');
	await page.getByLabel(/Acepto los/).check();
	await page.getByLabel(/Leí la/).check();
	await declareAdultIfAsked(page);
}

/** Sends the page's form as it is, with its fields enabled again, as a stale or tampered page would. */
async function forceSubmit(page: Page) {
	await Promise.all([
		page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/checkout'),
		page.evaluate(() => {
			const form = document.querySelector<HTMLFormElement>('form[method="POST"]')!;
			for (const element of form.querySelectorAll<HTMLInputElement | HTMLFieldSetElement | HTMLButtonElement>('[disabled]')) element.disabled = false;
			form.submit();
		})
	]);
	await page.waitForLoadState('load');
}

async function payWith(page: Page) {
	await page.getByRole('button', { name: /Ir a pagar/ }).click();
	await expect(page.getByRole('heading', { name: 'Simulador de pagos' })).toBeVisible();
	return /Orden (\S+)/.exec((await page.getByText(/^Orden /).textContent())!)![1]!;
}

async function expectProcessed(page: Page, reference: string) {
	const notice = page.getByRole('status').filter({ hasText: DONE });
	await expect(notice).toBeVisible();
	await expect(notice.getByRole('link', { name: 'Seguir comprando' })).toHaveAttribute('href', '/tienda');
	await expect(notice.getByRole('link', { name: 'Ver el estado de tu compra' })).toHaveAttribute('href', `/checkout/resultado?ref=${reference}`);
	await expect(page.getByRole('button', { name: /Ir a pagar/ }).and(page.locator(':enabled'))).toHaveCount(0);
}

test('going back to a checkout that was already sent says the purchase was processed', async ({ page, context }) => {
	await context.clearCookies();
	await toCheckout(page);
	await fillBuyer(page);
	const reference = await payWith(page);

	// The browser asks the server for the page again: its cart is gone, its order is not.
	await page.goBack();
	await expect(page).toHaveURL(/\/checkout$/);
	await expectProcessed(page, reference);

	// What was typed for that order is not offered again for the next one.
	await toCheckout(page);
	await expect(page.getByLabel('Nombre', { exact: true })).toBeEnabled();
	await expect(page.getByLabel('Nombre', { exact: true })).toHaveValue('');
	await expect(page.getByText(DONE)).toHaveCount(0);
});

test('a checkout page restored from the back/forward cache locks itself and is never sent twice', async ({ page, context }) => {
	await context.clearCookies();
	await toCheckout(page);
	await fillBuyer(page);
	const attempt = await page.locator('input[name="attempt"]').inputValue();

	// The order of that same page is created from another tab, as the page itself would when sent.
	const other = await context.newPage();
	await other.goto('/checkout', { waitUntil: 'networkidle' });
	await fillBuyer(other);
	await other.locator('input[name="attempt"]').evaluate((input: HTMLInputElement, value) => (input.value = value), attempt);
	const reference = await payWith(other);
	await other.close();

	// The browser shows the page again as it was kept in its back/forward cache.
	await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
	await expectProcessed(page, reference);
	await expect(page.getByRole('button', { name: /Ir a pagar/ })).toBeDisabled();
	await expect(page.getByLabel('Nombre', { exact: true })).toBeDisabled();
	await expect(page.getByLabel('Email', { exact: true })).toBeDisabled();
	await expect(page.getByLabel(/Acepto los/)).toBeDisabled();

	// Sent anyway, the server refuses it with the same notice.
	await forceSubmit(page);
	await expect(page).toHaveURL(/\/checkout$/);
	await expectProcessed(page, reference);
	await expect(page.getByRole('heading', { name: 'Simulador de pagos' })).toHaveCount(0);

	// The purchase this browser remembers is still that one.
	await page.goto('/checkout/resultado');
	await expect(page.locator('.code').first()).toHaveText(reference);
});

test('a checkout sent after its cart was emptied answers with a notice, not an error page', async ({ page, context }) => {
	await context.clearCookies();
	await toCheckout(page);
	await fillBuyer(page);
	await context.clearCookies();
	await page.getByRole('button', { name: /Ir a pagar/ }).click();
	await expect(page).toHaveURL(/\/checkout$/);
	const notice = page.getByRole('status').filter({ hasText: 'Tu carrito está vacío.' });
	await expect(notice).toBeVisible();
	await expect(notice.getByRole('link', { name: 'Seguir comprando' })).toHaveAttribute('href', '/tienda');
	await expect(page.getByRole('heading', { name: 'Simulador de pagos' })).toHaveCount(0);
});
