import { expect, test, type Locator, type Page } from '@playwright/test';
import { campaignOpen } from './campaign-state';

// odd/tasks/owner-feedback-2026-11-15d.md S1, S2: on a phone the shop shows the first product's add
// button on the first screen, and "Elegir producto y participar" ends with that button on screen.

const firstAddButton = (page: Page) => page.locator('#productos article').first().getByRole('button', { name: 'Agregar al carrito' });

/** The button's top and bottom against the screen, below the sticky header. */
async function position(button: Locator) {
	return button.evaluate((element) => {
		const box = element.getBoundingClientRect();
		const header = document.querySelector('header')?.getBoundingClientRect().bottom ?? 0;
		return { top: box.top, bottom: box.bottom, header: Math.max(0, header), height: window.innerHeight };
	});
}

test('the first add button shows whole on a 390 × 844 phone when landing on the shop', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto('/tienda', { waitUntil: 'networkidle' });
	const button = firstAddButton(page);
	await expect(button).toBeVisible();
	const { top, bottom, header, height } = await position(button);
	expect(top, 'below the header').toBeGreaterThanOrEqual(header);
	expect(bottom, 'above the bottom of the screen').toBeLessThanOrEqual(height);
});

for (const [width, height] of [
	[390, 844],
	[375, 667]
] as const) {
	test(`"Elegir producto y participar" ends with the first add button on a ${width} × ${height} screen`, async ({ page }) => {
		test.skip(!campaignOpen, 'the call to act shows only while the campaign accepts participations (E2E_CAMPAIGN_OPEN=1)');
		await page.setViewportSize({ width, height });
		await page.goto('/tienda', { waitUntil: 'networkidle' });
		const button = firstAddButton(page);
		// The hand inviting to tap it, only on the first card.
		await expect(page.locator('#productos article').first().locator('.add-nudge')).toBeVisible();
		await expect(page.locator('.add-nudge')).toHaveCount(1);
		const cta = page.getByRole('link', { name: 'Elegir producto y participar' });
		await cta.scrollIntoViewIfNeeded();
		await cta.click();
		await expect.poll(async () => (await position(button)).bottom).toBeLessThanOrEqual(height);
		// The smooth scroll has ended: the button is still whole on screen, below the header.
		await page.waitForTimeout(800);
		const settled = await position(button);
		expect(settled.top, 'below the header').toBeGreaterThanOrEqual(settled.header);
		expect(settled.bottom, 'above the bottom of the screen').toBeLessThanOrEqual(height);
		// Keyboard users continue from the products: the next Tab reaches their buttons.
		await expect(page.locator('#productos')).toBeFocused();
	});
}

// The campaign page marks no add button and shows no hand: its call to act still brings its products' section to the top.
test('the campaign page call to act still scrolls to the top of its products', async ({ page }) => {
	test.skip(!campaignOpen, 'the call to act shows only while the campaign accepts participations (E2E_CAMPAIGN_OPEN=1)');
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto('/tienda', { waitUntil: 'networkidle' });
	const transparency = await page.getByRole('link', { name: 'Transparencia y bases' }).first().getAttribute('href');
	await page.goto(transparency!.replace(/\/transparencia.*$/, ''), { waitUntil: 'networkidle' });
	await expect(page.locator('.add-nudge')).toHaveCount(0);
	await expect(page.locator('[data-reveal]')).toHaveCount(0);
	await page.getByRole('link', { name: 'Elegir producto y participar' }).click();
	const products = page.locator('#productos');
	await expect.poll(() => products.evaluate((section) => Math.round(section.getBoundingClientRect().top))).toBeLessThan(120);
	await page.waitForTimeout(800);
	expect(await products.evaluate((section) => section.getBoundingClientRect().top)).toBeGreaterThan(0);
	await expect(products).toBeFocused();
});
