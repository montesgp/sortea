import { createHmac } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { openAccount, signOut } from './admin-account';

// Remember this device for 30 days after the second factor
// (odd/tasks/launch-prep-2026-11-10.md, S1): with the box ticked, the next
// sign-ins on that browser ask only for the password; "Mi cuenta" forgets it.
// It enrols an authenticator app on operador@tallerdemo.local, which stays
// confirmed: `pnpm db:reset` (or `pnpm admin:user reset-mfa operador@tallerdemo.local`)
// makes the test runnable again.
const password = process.env.E2E_ADMIN_PASSWORD;
test.skip(!password, 'Set E2E_ADMIN_PASSWORD to the password printed by the seed');
const email = 'operador@tallerdemo.local';
const DAY_SECONDS = 24 * 60 * 60;

/** RFC 6238 with the app's parameters (SHA-1, 30 seconds, 6 digits), as the authenticator app computes it. */
function totp(base32: string, at = Date.now()) {
	const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
	let bits = '';
	for (const char of base32.replace(/=+$/, '').toUpperCase()) bits += alphabet.indexOf(char).toString(2).padStart(5, '0');
	const secret = Buffer.from(bits.match(/.{8}/g)!.map((byte) => parseInt(byte, 2)));
	const counter = Buffer.alloc(8);
	counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
	const mac = createHmac('sha1', secret).update(counter).digest();
	const offset = mac[mac.length - 1]! & 0x0f;
	return ((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).toString().padStart(6, '0');
}

async function signIn(page: Page) {
	await page.goto('/admin/login', { waitUntil: 'networkidle' });
	await page.getByLabel('Email').fill(email);
	await page.getByLabel('Contraseña').fill(password!);
	await page.getByRole('button', { name: 'Ingresar' }).click();
	await page.waitForURL((url) => !url.pathname.endsWith('/login'));
}

/** Whether this session counts as verified, whether or not the environment requires the second factor. */
async function expectVerified(page: Page, verified: boolean) {
	await page.goto('/admin/mfa');
	if (verified) await expect(page.getByText('Tu sesión ya está verificada.')).toBeVisible();
	else await expect(page.getByLabel('Código')).toBeVisible();
}

test('a remembered browser skips the code until its devices are forgotten', async ({ browser }) => {
	const own = await browser.newContext();
	const other = await browser.newContext();
	try {
		const page = await own.newPage();
		await signIn(page);
		await page.goto('/admin/mfa', { waitUntil: 'networkidle' });
		const configure = page.getByRole('button', { name: 'Configurar app de autenticación' });
		test.skip(!(await configure.isVisible()), `${email} already has an authenticator app: reset it to run this test`);
		await configure.click();
		const secret = await page.locator('.hash').innerText();
		await page.getByLabel('Código').fill(totp(secret));
		const remember = page.getByLabel('Recordar este dispositivo por 30 días');
		await expect(remember).not.toBeChecked();
		await remember.check();
		await page.getByRole('button', { name: 'Verificar' }).click();
		await page.waitForURL((url) => !url.pathname.endsWith('/mfa'));

		// httpOnly on /admin for 30 days: the page's JavaScript never sees it.
		const cookie = (await own.cookies()).find((item) => item.name === 'sortea_admin_trusted');
		expect(cookie).toMatchObject({ path: '/admin', httpOnly: true, sameSite: 'Lax' });
		expect(cookie!.expires - Date.now() / 1000).toBeGreaterThan(30 * DAY_SECONDS - 120);
		expect(cookie!.expires - Date.now() / 1000).toBeLessThanOrEqual(30 * DAY_SECONDS);
		expect(await page.evaluate(() => document.cookie)).not.toContain('sortea_admin_trusted');

		// Signing out keeps the device: the next sign-in asks only for the password.
		await page.goto('/admin');
		await signOut(page);
		await signIn(page);
		await expectVerified(page, true);

		// Another browser still needs the code.
		const elsewhere = await other.newPage();
		await signIn(elsewhere);
		await expectVerified(elsewhere, false);

		// "Mi cuenta" counts the device and forgets it in two steps.
		await page.goto('/admin');
		await openAccount(page);
		await expect(page.getByText('1 navegador entra sin pedirte el código')).toBeVisible();
		await page.getByRole('button', { name: 'Olvidar los dispositivos recordados' }).click();
		await expect(page.getByText('¿Olvidar el dispositivo recordado?')).toBeVisible();
		await page.getByRole('button', { name: 'Sí, olvidarlos' }).click();
		await expect(page.getByText('Listo: olvidamos 1 dispositivo.')).toBeVisible();
		await expect(page.getByText('Ningún navegador entra sin pedirte el código.')).toBeVisible();
		expect((await own.cookies()).find((item) => item.name === 'sortea_admin_trusted')).toBeUndefined();

		await signOut(page);
		await signIn(page);
		await expectVerified(page, false);
	} finally {
		await own.close();
		await other.close();
	}
});
