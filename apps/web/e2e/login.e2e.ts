import { expect, test } from '@playwright/test';

// Feedback 2026-10-17b: S1 password eye, S2 the panel resists guessing bots
// and stays out of search engines.

test('the password can be shown and hidden again', async ({ page }) => {
	await page.goto('/admin/login', { waitUntil: 'networkidle' });
	const password = page.getByLabel('Contraseña');
	await password.fill('una-clave-de-prueba');
	await expect(password).toHaveAttribute('type', 'password');
	const eye = page.getByRole('button', { name: 'Mostrar' });
	await expect(eye).toHaveAttribute('aria-pressed', 'false');
	await eye.click();
	await expect(password).toHaveAttribute('type', 'text');
	await expect(eye).toHaveAttribute('aria-pressed', 'true');
	await eye.click();
	await expect(password).toHaveAttribute('type', 'password');
	await expect(password).toHaveValue('una-clave-de-prueba');
});

test('the panel asks search engines not to list it; the public site does not', async ({ request }) => {
	expect((await request.get('/admin/login')).headers()['x-robots-tag']).toBe('noindex, nofollow');
	expect((await request.get('/')).headers()['x-robots-tag']).toBeUndefined();
});

test('after five wrong passwords for one account the panel makes the next try wait', async ({ page }) => {
	const email = `bot-${Date.now()}@nadie.test`;
	await page.goto('/admin/login', { waitUntil: 'networkidle' });
	for (let attempt = 0; attempt < 5; attempt++) {
		await page.getByLabel('Email').fill(email);
		await page.getByLabel('Contraseña').fill(`adivinanza-${attempt}`);
		await page.getByRole('button', { name: 'Ingresar' }).click();
		await expect(page.getByRole('alert')).toHaveText('Email o contraseña incorrectos');
	}
	await page.getByLabel('Email').fill(email);
	await page.getByLabel('Contraseña').fill('otra-adivinanza');
	await page.getByRole('button', { name: 'Ingresar' }).click();
	await expect(page.getByRole('alert')).toHaveText('Demasiados intentos fallidos. Esperá 15 minutos y probá de nuevo.');
});
