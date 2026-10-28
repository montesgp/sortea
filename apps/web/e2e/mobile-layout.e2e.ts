import { expect, test, type Locator, type Page } from '@playwright/test';

// Feedback 2026-10-28 S1: on mobile the bases and transparency pages were cut
// on the right, without the margin the left side keeps.
const slug = 'tornado-300';

async function expectFitsWithEqualMargins(page: Page, region: Locator) {
	await expect(region).toBeVisible();
	const layout = await region.evaluate((element) => {
		const viewport = document.documentElement.clientWidth;
		const box = element.getBoundingClientRect();
		let right = box.right;
		for (const child of element.querySelectorAll('*')) {
			const rect = child.getBoundingClientRect();
			if (rect.width) right = Math.max(right, rect.right);
		}
		return { viewport, scrollWidth: document.documentElement.scrollWidth, left: box.left, right: viewport - box.right, contentOverflow: right - box.right };
	});
	expect(layout.scrollWidth, 'the page does not scroll sideways').toBeLessThanOrEqual(layout.viewport);
	expect(layout.left, 'the content keeps a side margin').toBeGreaterThan(0);
	expect(Math.abs(layout.left - layout.right), 'left and right margins match').toBeLessThanOrEqual(1);
	expect(layout.contentOverflow, 'nothing sticks out of the content column').toBeLessThanOrEqual(1);
}

for (const width of [390, 360]) {
	test(`the campaign bases keep equal side margins at ${width}px`, async ({ page }) => {
		await page.setViewportSize({ width, height: 844 });
		await page.goto(`/sorteos/${slug}`);
		await expectFitsWithEqualMargins(page, page.getByRole('region', { name: 'Bases y condiciones' }));
		await expectFitsWithEqualMargins(page, page.locator('main > .hero'));
	});

	test(`the transparency page keeps equal side margins at ${width}px`, async ({ page }) => {
		await page.setViewportSize({ width, height: 844 });
		await page.goto(`/sorteos/${slug}/transparencia`);
		await expectFitsWithEqualMargins(page, page.locator('main > .container').filter({ has: page.getByRole('heading', { name: 'Transparencia', level: 1 }) }));
	});
}
