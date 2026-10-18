import { expect, test, type Page } from '@playwright/test';

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

const password = process.env.E2E_ADMIN_PASSWORD;

async function submit(page: Page, email: string, secret: string) {
	await page.getByLabel('Email').fill(email);
	await page.getByLabel('Contraseña').fill(secret);
	await page.getByRole('button', { name: 'Ingresar' }).click();
}

// Targeted lockout follow-up: failures from another device slow that device
// down, and the admin still signs in from the browser they used before.
test('an attacker who knows an admin email is slowed down, and the admin still signs in from a known browser', async ({ browser }) => {
	test.skip(!password, 'Set E2E_ADMIN_PASSWORD to the password printed by the seed');
	const email = 'finanzas@motogarage.local';
	const admin = await browser.newContext();
	const attacker = await browser.newContext();
	try {
		const own = await admin.newPage();
		await own.goto('/admin/login', { waitUntil: 'networkidle' });
		await submit(own, email, password!);
		await own.waitForURL((url) => !url.pathname.endsWith('/login'));
		const cookie = (await admin.cookies()).find((item) => item.name === 'sortea_device');
		expect(cookie).toMatchObject({ path: '/admin', httpOnly: true, sameSite: 'Strict' });
		expect(cookie!.value).not.toContain('finanzas');
		await own.getByRole('button', { name: 'Cerrar sesión' }).click();
		await own.waitForURL(/\/admin\/login$/);

		const bot = await attacker.newPage();
		await bot.goto('/admin/login', { waitUntil: 'networkidle' });
		let wait = 0;
		for (let attempt = 0; attempt < 12 && wait < 4; attempt++) {
			await submit(bot, email, `adivinanza-${attempt}`);
			const message = (await bot.getByRole('alert').textContent()) ?? '';
			const seconds = /^Demasiados intentos fallidos\. Esperá (\d+) segundos? y probá de nuevo\.$/.exec(message);
			if (seconds) wait = Number(seconds[1]);
			else expect(message).toBe('Email o contraseña incorrectos');
		}
		expect(wait).toBeGreaterThanOrEqual(4);
		// Even the right password waits on the attacker's device.
		await submit(bot, email, password!);
		await expect(bot.getByRole('alert')).toHaveText(/^Demasiados intentos fallidos\. Esperá \d+ segundos? y probá de nuevo\.$/);

		await submit(own, email, password!);
		await own.waitForURL((url) => !url.pathname.endsWith('/login'));
		await expect(own.getByRole('navigation', { name: 'Panel' })).toBeVisible();
	} finally {
		await admin.close();
		await attacker.close();
	}
});
