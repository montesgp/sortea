import { expect, test, type Page } from '@playwright/test';

// S5 (feedback 2026-10-18): the email is checked while typed and as soon as
// both fields are filled, before the server answers.

async function toCheckout(page: Page) {
	await page.goto('/tienda', { waitUntil: 'networkidle' });
	await page.getByRole('article').filter({ hasText: 'Manual técnico' }).getByRole('button', { name: 'Agregar al carrito' }).click();
	await expect(page).toHaveURL(/\/carrito$/);
	await page.goto('/checkout', { waitUntil: 'networkidle' });
}

test('the checkout flags a malformed email and a different confirmation without sending the form', async ({ page }) => {
	await toCheckout(page);
	const email = page.getByLabel('Email', { exact: true });
	const confirm = page.getByLabel('Repetí el email');

	await email.fill('ana@');
	await expect(page.getByText('Ingresá un email válido')).toHaveCount(0);
	await email.blur();
	await expect(page.locator('#email-error')).toHaveText('Ingresá un email válido');
	await expect(email).toHaveAttribute('aria-invalid', 'true');
	await email.fill('ana@mail.com');
	await expect(page.locator('#email-error')).toHaveCount(0);

	await confirm.fill('ana@mail.cop');
	await expect(page.locator('#emailConfirm-error')).toHaveText('Los emails no coinciden');
	await confirm.fill(' ANA@mail.com');
	await expect(page.locator('#emailConfirm-error')).toHaveText('Los emails coinciden');
	await expect(confirm).toHaveAttribute('aria-invalid', 'false');
	await expect(page).toHaveURL(/\/checkout$/);
});
