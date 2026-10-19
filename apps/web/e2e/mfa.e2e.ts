import { expect, test } from '@playwright/test';

// Feedback 2026-10-17 S1: abandoning the enrolment used to leave an unverified
// factor named after the day, and enrolling again failed until the next day.
const password = process.env.E2E_ADMIN_PASSWORD;
test.skip(!password, 'Set E2E_ADMIN_PASSWORD to the password printed by the seed');

test('enrolling again after leaving the QR unscanned shows a new QR', async ({ page }) => {
	await page.goto('/admin/login');
	await page.getByLabel('Email').fill('finanzas@motogarage.local');
	await page.getByLabel('Contraseña').fill(password!);
	await page.getByRole('button', { name: 'Ingresar' }).click();
	await page.waitForURL((url) => !url.pathname.endsWith('/login'));

	const qr = page.getByRole('img', { name: 'Código QR para la app de autenticación' });
	const secrets: string[] = [];
	for (let attempt = 0; attempt < 2; attempt++) {
		// Leaving the page without verifying is the abandoned enrolment.
		await page.goto('/admin/mfa');
		await page.getByRole('button', { name: 'Configurar app de autenticación' }).click();
		await expect(page.getByRole('alert')).toHaveCount(0);
		await expect(qr).toBeVisible();
		expect(await qr.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBeGreaterThan(0);
		secrets.push(await page.locator('.hash').innerText());
	}
	expect(secrets[1]).not.toBe(secrets[0]);

	// Cancelling removes the pending factor and goes back to the panel, with a clean address.
	await page.getByRole('button', { name: 'Cancelar' }).click();
	await expect(page).toHaveURL(/\/admin$/);
	await expect(page.getByRole('navigation', { name: 'Panel' })).toBeVisible();
	await page.goto('/admin/mfa');
	await expect(qr).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Configurar app de autenticación' })).toBeVisible();
	await expect(page.getByLabel('Código')).toHaveCount(0);
});

// Feedback 2026-10-17 (round 4): the page had no way back to the panel.
test('the two-step page always offers a way back to the panel and out of the session', async ({ page }) => {
	await page.goto('/admin/login');
	await page.getByLabel('Email').fill('finanzas@motogarage.local');
	await page.getByLabel('Contraseña').fill(password!);
	await page.getByRole('button', { name: 'Ingresar' }).click();
	await page.waitForURL((url) => !url.pathname.endsWith('/login'));

	await page.goto('/admin/mfa');
	await page.getByRole('link', { name: 'Volver al panel' }).click();
	await expect(page).toHaveURL(/\/admin$/);

	await page.goto('/admin/mfa', { waitUntil: 'networkidle' });
	// Each step updates the page in place, without a full reload (feedback 2026-10-19).
	await page.evaluate(() => ((window as unknown as { __kept: boolean }).__kept = true));
	await page.getByRole('button', { name: 'Configurar app de autenticación' }).click();
	await expect(page.getByRole('img', { name: 'Código QR para la app de autenticación' })).toBeVisible();
	expect(await page.evaluate(() => (window as unknown as { __kept?: boolean }).__kept)).toBe(true);
	await expect(page.getByRole('link', { name: 'Volver al panel' })).toBeVisible();
	await page.getByRole('button', { name: 'Cerrar sesión' }).click();
	await expect(page).toHaveURL(/\/admin\/login$/);
});
