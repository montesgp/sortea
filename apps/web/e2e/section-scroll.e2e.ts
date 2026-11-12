import { expect, test } from '@playwright/test';

// odd/tasks/owner-feedback-2026-11-11b.md S6: "Ver los productos" glides to the products instead
// of jumping, so the visitor sees they are still on the same page.
test('"Ver los productos" in the shop scrolls smoothly to the products', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto('/tienda');
	// Click after hydration: before it, the link keeps the browser's plain jump.
	await page.waitForLoadState('networkidle');
	const link = page.getByRole('link', { name: 'Ver los productos' });
	test.skip((await link.count()) === 0, 'the shop shows no featured campaign');
	await link.click();
	// Shortly after the click the page is on its way: neither at the top nor already at the products.
	await page.waitForTimeout(120);
	const midway = await page.evaluate(() => window.scrollY);
	const products = page.locator('#productos');
	await expect.poll(() => products.evaluate((section) => Math.round(section.getBoundingClientRect().top))).toBeLessThan(120);
	const arrived = await page.evaluate(() => window.scrollY);
	expect(midway, 'the scroll had started').toBeGreaterThan(0);
	expect(midway, 'the scroll was still moving, not a jump').toBeLessThan(arrived);
	// The section starts below the sticky header and the address keeps the shop's own URL.
	expect(await products.evaluate((section) => section.getBoundingClientRect().top)).toBeGreaterThan(0);
	await expect(products).toBeFocused();
	expect(new URL(page.url()).pathname).toBe('/tienda');
});
