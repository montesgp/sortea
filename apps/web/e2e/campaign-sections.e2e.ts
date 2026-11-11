import { expect, test } from '@playwright/test';

// odd/tasks/owner-feedback-2026-11-11.md S2-S3: on the campaign page the FAQs come right after
// the products, the authorizations and the bases go last, and the bases stay collapsed until
// the visitor opens them.
const slug = 'tornado-300';

test('the FAQs follow the products and the authorizations and bases close the page', async ({ page }) => {
	await page.goto(`/sorteos/${slug}`);
	// Section titles only: product cards and the bases text have headings of their own.
	const headings = await page.locator('main section > h2').allInnerTexts();
	const order = ['Productos', 'Preguntas frecuentes', 'Autorizaciones', 'Bases y condiciones'];
	const positions = order.map((title) => headings.findIndex((heading) => heading.trim().toLowerCase() === title.toLowerCase()));
	for (const [index, title] of order.entries()) expect(positions[index], `${title} is on the page`).toBeGreaterThanOrEqual(0);
	expect(positions, 'Productos, Preguntas frecuentes, Autorizaciones, Bases y condiciones in that order').toEqual([...positions].sort((a, b) => a - b));
	expect(positions.at(-1), 'the bases are the last section').toBe(headings.length - 1);
});

test('the bases stay collapsed until the visitor opens them', async ({ page }) => {
	await page.goto(`/sorteos/${slug}`);
	const bases = page.getByRole('region', { name: 'Bases y condiciones' });
	// The version and fingerprint stay in sight; the text itself waits for the visitor.
	await expect(bases).toContainText('Versión');
	const text = bases.getByText('Este texto es un borrador que muestra cómo se publican las bases.');
	await expect(text).toBeHidden();
	const toggle = bases.getByText('Leer las bases y condiciones');
	await toggle.click();
	await expect(text).toBeVisible();
	await toggle.click();
	await expect(text).toBeHidden();
});
