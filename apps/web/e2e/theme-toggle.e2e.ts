import { expect, test } from '@playwright/test';

// Feedback 2026-10-19: switching light/dark happens in the browser only, with
// no request to the server and nothing stored; the next load uses the site's
// default again.

test('the theme switches in place, stores nothing and the next load uses the default', async ({ page, context }) => {
	await context.clearCookies();
	await page.goto('/tienda', { waitUntil: 'networkidle' });
	const html = page.locator('html');
	const initial = await html.getAttribute('data-mode');
	const other = initial === 'dark' ? 'light' : 'dark';
	await page.evaluate(() => ((window as unknown as { __kept: boolean }).__kept = true));
	const requests: string[] = [];
	page.on('request', (request) => requests.push(new URL(request.url()).pathname));

	const toggle = page.locator('header').getByRole('button', { name: other === 'light' ? 'Usar tema claro' : 'Usar tema oscuro' });
	await toggle.click();
	await expect(html).toHaveAttribute('data-mode', other);
	await expect(page.locator('header').getByRole('button', { name: initial === 'light' ? 'Usar tema claro' : 'Usar tema oscuro' })).toBeVisible();
	expect(await page.evaluate(() => (window as unknown as { __kept?: boolean }).__kept)).toBe(true);
	expect(requests.filter((path) => !path.startsWith('/@') && !path.startsWith('/node_modules') && !path.startsWith('/src'))).toEqual([]);
	expect((await context.cookies()).map((cookie) => cookie.name)).not.toContain('sortea_mode');

	await page.reload({ waitUntil: 'networkidle' });
	await expect(html).toHaveAttribute('data-mode', initial!);
});

test('an old stored preference is ignored', async ({ page, context }) => {
	await page.goto('/tienda', { waitUntil: 'networkidle' });
	const initial = await page.locator('html').getAttribute('data-mode');
	const url = new URL(page.url());
	await context.addCookies([{ name: 'sortea_mode', value: initial === 'dark' ? 'light' : 'dark', domain: url.hostname, path: '/' }]);
	await page.reload({ waitUntil: 'networkidle' });
	await expect(page.locator('html')).toHaveAttribute('data-mode', initial!);
});
