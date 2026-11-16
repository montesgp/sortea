import { expect, test, type Page } from '@playwright/test';
import { STEP_ONE, STEP_TWO } from './checkout-form';

// S5 (feedback 2026-10-18): the email is checked while typed, before the server answers.
// Checkout in two steps S5: one email field, no confirmation, and help at the moment when a
// common domain looks mistyped.

async function toCheckout(page: Page) {
	await page.goto('/tienda', { waitUntil: 'networkidle' });
	await page.getByRole('article').filter({ hasText: 'Manual técnico' }).getByRole('button', { name: 'Agregar al carrito' }).click();
	await expect(page).toHaveURL(/\/carrito$/);
	await page.goto('/checkout', { waitUntil: 'networkidle' });
}

test('the checkout flags a malformed email and offers the fix of a mistyped domain without sending the form', async ({ page }) => {
	await toCheckout(page);
	const email = page.getByLabel('Email', { exact: true });
	await expect(page.getByLabel(/Repetí el email/)).toHaveCount(0);

	await email.fill('ana@');
	await expect(page.getByText('Ingresá un email válido')).toHaveCount(0);
	await email.blur();
	await expect(page.locator('#email-error')).toHaveText('Ingresá un email válido');
	await expect(email).toHaveAttribute('aria-invalid', 'true');
	await email.fill('ana@hotmial.com');
	await expect(page.locator('#email-error')).toHaveCount(0);

	await email.blur();
	await expect(page.getByText('¿Quisiste decir ana@hotmail.com?')).toBeVisible();
	await page.getByRole('button', { name: 'ana@hotmail.com' }).click();
	await expect(email).toHaveValue('ana@hotmail.com');
	await expect(email).toBeFocused();
	await expect(page.getByText(/Quisiste decir/)).toHaveCount(0);
	await expect(email).toHaveAttribute('aria-invalid', 'false');

	// A typo the buyer did not see yet stops Continuar once, so it is read; the second press goes on.
	await page.getByLabel('Nombre', { exact: true }).fill('Ana');
	await page.getByLabel('Apellido', { exact: true }).fill('Pérez');
	await page.reload({ waitUntil: 'networkidle' });
	await expect(page.getByLabel('Apellido', { exact: true })).toHaveValue('Pérez');
	await email.fill('ana@gmail.con');
	await expect(page.getByText(/Quisiste decir/)).toHaveCount(0);
	await page.keyboard.press('Enter');
	await expect(page.getByText('¿Quisiste decir ana@gmail.com?')).toBeVisible();
	await expect(email).toBeFocused();
	await expect(page.getByRole('heading', { name: STEP_ONE })).toBeVisible();
	await page.keyboard.press('Enter');
	await expect(page.getByRole('heading', { name: STEP_TWO })).toBeVisible();
	await expect(page.getByText('Te lo enviamos a ana@gmail.con')).toBeVisible();
	await expect(page).toHaveURL(/\/checkout$/);
});
