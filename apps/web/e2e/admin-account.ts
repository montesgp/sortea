import { expect, type Page } from '@playwright/test';

// Owner feedback 2026-11-10 S11: the account, the password, the second factor and
// signing out live in the user menu of the panel and its "Mi cuenta" page.

/** Opens the user menu at the foot of the panel's sidebar. */
export async function openUserMenu(page: Page) {
	const menu = page.locator('details.account');
	if (!(await menu.evaluate((element: HTMLDetailsElement) => element.open))) await menu.locator('summary').click();
	return menu;
}

export async function openAccount(page: Page) {
	await (await openUserMenu(page)).getByRole('link', { name: 'Mi cuenta' }).click();
	await expect(page).toHaveURL(/\/admin\/cuenta$/);
	// Choose after hydration, or Svelte re-applies the theme the server rendered as checked.
	await page.waitForLoadState('networkidle');
}

/** Signs out from the user menu; the sign-in steps outside the panel keep their own button. */
export async function signOut(page: Page) {
	if (await page.locator('details.account').count()) await (await openUserMenu(page)).getByRole('button', { name: 'Cerrar sesión' }).click();
	else await page.getByRole('button', { name: 'Cerrar sesión' }).click();
}
