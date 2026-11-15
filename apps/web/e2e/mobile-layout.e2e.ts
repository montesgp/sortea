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
		// What a strip scrolls inside its own box (the prize gallery thumbnails) does not stick out.
		const scrolled = (child: Element) => {
			for (let parent = child.parentElement; parent && parent !== element; parent = parent.parentElement) {
				if (getComputedStyle(parent).overflowX !== 'visible') return true;
			}
			return false;
		};
		for (const child of element.querySelectorAll('*')) {
			if (scrolled(child)) continue;
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

/** Nothing on the page reaches past the screen's right edge (owner feedback 2026-11-14, S8). */
async function expectNoSidewaysScroll(page: Page, path: string) {
	const { scrollWidth, innerWidth } = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));
	expect(scrollWidth, `${path} does not scroll sideways`).toBeLessThanOrEqual(innerWidth);
}

// Owner feedback 2026-11-14 S8: on an iPhone the campaign hero was off center and cut on the right, its caption under the status chips.
for (const [width, height] of [
	[390, 844],
	[375, 667]
]) {
	test(`the campaign hero stays inside the screen, centered and clear of the chips at ${width}x${height}`, async ({ page }) => {
		await page.setViewportSize({ width, height });
		await page.goto(`/sorteos/${slug}`, { waitUntil: 'networkidle' });
		await expectNoSidewaysScroll(page, `/sorteos/${slug}`);
		// The main prize gallery when it has photos, else the placeholder sign.
		const media = page.locator('main > .hero .plate');
		const box = (await media.boundingBox())!;
		expect(box.x).toBeGreaterThan(0);
		expect(box.x + box.width).toBeLessThanOrEqual(width);
		expect(Math.abs(box.x - (width - box.x - box.width)), 'centered').toBeLessThanOrEqual(1);
		const chips = (await page.locator('main > .hero .chips').boundingBox())!;
		expect(chips.y, 'the chips start below the media').toBeGreaterThanOrEqual(box.y + box.height);
	});
}

// S8 across the public site, with the Taller Demo seed: every page fits a 390 px phone.
test('the public pages fit a 390 px screen', async ({ page, context }) => {
	await context.clearCookies();
	await page.setViewportSize({ width: 390, height: 844 });
	const paths = ['/', '/tienda', '/sorteos', `/sorteos/${slug}`, `/sorteos/${slug}/transparencia`, '/consulta', '/legales/terminos', '/legales/privacidad', '/arrepentimiento', '/carrito'];
	for (const path of paths) {
		await page.goto(path, { waitUntil: 'networkidle' });
		await expectNoSidewaysScroll(page, path);
	}
	// A product page, and the cart and the checkout with something in them.
	await page.goto('/tienda/remera', { waitUntil: 'networkidle' });
	await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
	await expectNoSidewaysScroll(page, '/tienda/remera');
	await page.goto('/tienda', { waitUntil: 'networkidle' });
	await page.getByRole('article').filter({ hasText: 'Manual técnico' }).first().getByRole('button', { name: 'Agregar al carrito' }).click();
	await expect(page).toHaveURL(/\/carrito$/);
	await expectNoSidewaysScroll(page, '/carrito (with a product)');
	await page.goto('/checkout', { waitUntil: 'networkidle' });
	await expectNoSidewaysScroll(page, '/checkout');
	// The campaign bases, open.
	await page.goto(`/sorteos/${slug}`, { waitUntil: 'networkidle' });
	await page.getByText('Leer las bases y condiciones').click();
	await expectNoSidewaysScroll(page, `/sorteos/${slug} (bases open)`);
});

for (const width of [390, 360]) {
	test(`the campaign bases keep equal side margins at ${width}px`, async ({ page }) => {
		await page.setViewportSize({ width, height: 844 });
		await page.goto(`/sorteos/${slug}`);
		const bases = page.getByRole('region', { name: 'Bases y condiciones' });
		// The text is collapsed by default (feedback 2026-11-11 S3); open it to measure it.
		await bases.getByText('Leer las bases y condiciones').click();
		await expectFitsWithEqualMargins(page, bases);
		await expectFitsWithEqualMargins(page, page.locator('main > .hero'));
	});

	test(`the transparency page keeps equal side margins at ${width}px`, async ({ page }) => {
		await page.setViewportSize({ width, height: 844 });
		await page.goto(`/sorteos/${slug}/transparencia`);
		await expectFitsWithEqualMargins(page, page.locator('main > .container').filter({ has: page.getByRole('heading', { name: 'Transparencia', level: 1 }) }));
	});
}
