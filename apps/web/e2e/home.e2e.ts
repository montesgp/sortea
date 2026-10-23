import { expect, test, type Page } from '@playwright/test';

// Owner feedback 2026-10-16 (S1): the pistons kept still while items 03 and 04
// passed. They must turn through every process item and stop at the last one.

/** Crank angle in degrees and the highlighted item, once the scrub settles. */
async function settled(page: Page) {
	const read = () =>
		page.evaluate(() => {
			const crank = document.querySelector('.cycle .crank')?.getAttribute('transform') ?? 'rotate(0)';
			const items = [...document.querySelectorAll('.cycle li')];
			return { angle: Number(/rotate\(([-\d.]+)\)/.exec(crank)?.[1] ?? 0), current: items.findIndex((item) => item.classList.contains('current')) };
		});
	let previous = await read();
	for (let attempt = 0; attempt < 30; attempt++) {
		await page.waitForTimeout(150);
		const next = await read();
		if (next.angle === previous.angle && next.current === previous.current) return next;
		previous = next;
	}
	return previous;
}

/** Scrolls so the top of process item `index` sits just above the line at 60% of the viewport. */
async function reach(page: Page, index: number) {
	await page.evaluate((index) => {
		const item = document.querySelectorAll('.cycle li')[index]!;
		scrollTo(0, item.getBoundingClientRect().top + scrollY - innerHeight * 0.6 + 8);
	}, index);
	return settled(page);
}

for (const [width, height] of [
	[1366, 900],
	[390, 844]
]) {
	test(`the pistons turn through every process item and stop at the last one at ${width}px`, async ({ page }) => {
		await page.setViewportSize({ width, height });
		await page.goto('/');
		const cycle = page.locator('section.cycle.scrubbed');
		// app.html drops `motion` when the app takes over 3.5 s to start, and the pistons then stay
		// still (meant for slow devices). Under a full e2e run the dev server can be that slow on the
		// first load; reload once, with the modules already transformed, before checking the motion.
		await expect(cycle.or(page.locator('html:not(.motion)'))).toBeAttached({ timeout: 20_000 });
		if ((await cycle.count()) === 0) await page.reload();
		await expect(cycle).toBeAttached({ timeout: 20_000 });
		const total = await cycle.getByRole('listitem').count();
		expect(total).toBeGreaterThan(2);

		const angles: number[] = [];
		for (let index = 0; index < total; index++) {
			const { angle, current } = await reach(page, index);
			expect(current, `item ${index + 1} is highlighted when it is reached`).toBe(index);
			angles.push(angle);
		}
		// The pistons are still in view when the last item is reached.
		const visual = (await cycle.locator('.visual').boundingBox())!;
		expect(visual.y).toBeGreaterThanOrEqual(0);
		expect(visual.y + visual.height).toBeLessThanOrEqual(height);
		for (let index = 1; index < total; index++) expect(angles[index], `the crank turns on the way to item ${index + 1}`).toBeGreaterThan(angles[index - 1]!);

		// Past the last item the motion is over.
		await page.mouse.wheel(0, 300);
		const after = await settled(page);
		expect(after.current).toBe(total - 1);
		expect(after.angle).toBe(angles[total - 1]);
	});
}

test('with reduced motion the process list is static', async ({ browser }) => {
	const context = await browser.newContext({ reducedMotion: 'reduce' });
	const page = await context.newPage();
	await page.goto('/');
	const cycle = page.locator('section.cycle');
	await expect(cycle.getByRole('listitem').first()).toBeVisible();
	await page.waitForTimeout(500);
	await expect(cycle).not.toHaveClass(/scrubbed/);
	await expect(cycle.locator('li.current')).toHaveCount(0);
	await context.close();
});
