import { expect, test, type Page } from '@playwright/test';

// Feedback 2026-10-28 S7: the coupon lookup an operator runs during the draw stream.
// Seed data never carries approvals and the local demo campaign sells no coupons
// before it opens, so here the screen covers the "not sold" and validation states,
// the session list, presentation mode and the plain-form fallback. Winners, consent,
// void coupons and tenant isolation are covered by apps/api/test/coupon-lookup.test.ts
// and the wording of each state by src/lib/coupon-lookup.test.ts.
const password = process.env.E2E_ADMIN_PASSWORD;
test.skip(!password, 'Set E2E_ADMIN_PASSWORD to the password printed by the seed');

async function signIn(page: Page) {
	await page.goto('/admin/login');
	await page.getByLabel('Email').fill('operador@motogarage.local');
	await page.getByLabel('Contraseña').fill(password!);
	await page.getByRole('button', { name: 'Ingresar' }).click();
	await expect(page.getByRole('heading', { name: 'Resumen' })).toBeVisible();
}

async function openLiveLookup(page: Page) {
	await signIn(page);
	await page.getByRole('link', { name: 'Campañas' }).click();
	await page.getByRole('link', { name: /Honda Tornado/ }).click();
	await page.getByRole('link', { name: 'Buscador de cupones en vivo' }).click();
	await expect(page.getByRole('heading', { name: 'Buscador en vivo' })).toBeVisible();
}

test('searches coupons with the keyboard only, without reloading, and keeps the list in order', async ({ page }) => {
	await openLiveLookup(page);
	const input = page.getByLabel('Número de cupón');
	await expect(input).toBeFocused();
	await page.evaluate(() => ((window as unknown as { marker: number }).marker = 1));

	// Four digits search on their own.
	await page.keyboard.type('9999');
	const result = page.getByRole('article', { name: 'Resultado del cupón N.º 9999' });
	await expect(result).toBeVisible();
	await expect(result.getByRole('heading', { name: 'Cupón no vendido' })).toBeVisible();
	await expect(result.getByText('Nadie compró este número en esta campaña')).toBeVisible();
	await expect(input).toBeFocused();
	await expect(input).toHaveValue('');

	// Fewer digits, spaces and Enter.
	await page.keyboard.type('99 98');
	await expect(page.getByRole('article', { name: 'Resultado del cupón N.º 9998' })).toBeVisible();

	// Invalid input never reaches the API.
	await page.keyboard.type('abc');
	await page.keyboard.press('Enter');
	await expect(page.getByRole('alert')).toHaveText('Escribí el número de cupón, por ejemplo 0042');
	await expect(input).toBeFocused();

	const list = page.getByRole('region', { name: 'Cupones buscados' }).getByRole('listitem');
	await expect(list).toHaveText([/1\.º\s*9999\s*No vendido/, /2\.º\s*9998\s*No vendido/]);
	expect(await page.evaluate(() => (window as unknown as { marker?: number }).marker)).toBe(1);

	await page.getByRole('button', { name: 'Limpiar lista' }).click();
	await expect(list).toHaveCount(0);
	await expect(page.getByText('Todavía no buscaste ningún cupón.')).toBeVisible();
});

test('presentation mode hides the admin chrome and Escape brings it back', async ({ page }) => {
	await openLiveLookup(page);
	await page.getByRole('link', { name: 'Modo presentación' }).click();
	await expect(page).toHaveURL(/presentacion/);
	await expect(page.getByRole('link', { name: 'Volver a' })).toHaveCount(0);
	// The lookup covers the whole viewport, the sidebar included.
	const covered = await page.evaluate(() => {
		const sidebar = document.querySelector('.sidebar')!.getBoundingClientRect();
		const top = document.elementFromPoint(sidebar.left + 10, sidebar.top + 10);
		return !document.querySelector('.sidebar')!.contains(top);
	});
	expect(covered).toBe(true);
	await expect(page.getByLabel('Número de cupón')).toBeFocused();
	await page.keyboard.type('9999');
	await expect(page.getByRole('heading', { name: 'Cupón no vendido' })).toBeVisible();

	await page.keyboard.press('Escape');
	await expect(page).not.toHaveURL(/presentacion/);
	await expect(page.getByRole('link', { name: 'Modo presentación' })).toBeVisible();
});

test.describe('without JavaScript', () => {
	test.use({ javaScriptEnabled: false });

	test('a plain form submit still searches and lists the coupons', async ({ page }) => {
		await signIn(page);
		await page.getByRole('link', { name: 'Campañas' }).click();
		await page.getByRole('link', { name: /Honda Tornado/ }).click();
		await page.getByRole('link', { name: 'Buscador de cupones en vivo' }).click();
		await page.getByLabel('Número de cupón').fill('9999');
		await page.getByRole('button', { name: 'Buscar' }).click();
		await expect(page.getByRole('heading', { name: 'Cupón no vendido' })).toBeVisible();
		await page.getByLabel('Número de cupón').fill('');
		await page.getByRole('button', { name: 'Buscar' }).click();
		await expect(page.getByText('Escribí el número de cupón, por ejemplo 0042')).toBeVisible();
		await page.getByLabel('Número de cupón').fill('9998');
		await page.getByRole('button', { name: 'Buscar' }).click();
		await expect(page.getByRole('region', { name: 'Cupones buscados' }).getByRole('listitem')).toHaveText([/9999\s*No vendido/, /9998\s*No vendido/]);
	});
});
