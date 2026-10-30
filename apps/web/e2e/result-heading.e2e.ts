import { expect, test, type Page } from '@playwright/test';
import { declareAdultIfAsked } from './checkout-consents';

// S6 (owner feedback 2026-10-30): the opening "¡" of the paid result heading renders in the display
// font, hangs outside the text edge and the heading lines align on the left.

async function buyAndPay(page: Page) {
	const email = `e2e-heading-${Date.now()}@example.com`;
	await page.goto('/tienda');
	await page.getByRole('article').filter({ hasText: 'Manual técnico' }).getByRole('button', { name: 'Agregar al carrito' }).click();
	await page.getByRole('link', { name: 'Continuar con la compra' }).click();
	await page.getByLabel('Nombre', { exact: true }).fill('Prueba');
	await page.getByLabel('Apellido').fill('Título');
	await page.getByLabel('Número').fill(String(20_000_000 + Math.floor(Math.random() * 9_000_000)));
	await page.getByLabel('Email', { exact: true }).fill(email);
	await page.getByLabel('Repetí el email').fill(email);
	await page.getByLabel('Provincia', { exact: true }).selectOption('Buenos Aires');
	await page.getByLabel('Ciudad', { exact: true }).fill('Arrecifes');
	await page.getByLabel(/Acepto los/).check();
	await page.getByLabel(/Leí la/).check();
	await declareAdultIfAsked(page);
	await page.getByRole('button', { name: /Ir a pagar/ }).click();
	await page.getByRole('button', { name: 'Aprobar pago' }).click();
}

/** Right edge of the opening inverted mark and left edge of the first letter of each rendered line of the heading. */
function measureHeading(page: Page) {
	return page.locator('h1').evaluate((heading) => {
		let mark: { text: string; right: number; font: string } | undefined;
		const lines = new Map<number, number>();
		const walker = document.createTreeWalker(heading, NodeFilter.SHOW_TEXT);
		for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
			for (let index = 0; index < node.length; index++) {
				const char = node.data[index]!;
				if (!char.trim()) continue;
				const range = document.createRange();
				range.setStart(node, index);
				range.setEnd(node, index + 1);
				const rect = range.getBoundingClientRect();
				if (!mark && !lines.size && (char === '¡' || char === '¿')) {
					mark = { text: char, right: rect.right, font: getComputedStyle(node.parentElement!).fontFamily };
					continue;
				}
				const top = Math.round(rect.top);
				if (!lines.has(top)) lines.set(top, rect.left);
			}
		}
		return { mark, headingFont: getComputedStyle(heading).fontFamily, lineStarts: [...lines.values()] };
	});
}

/** The font files Chromium actually used to draw the text of the first node matching `selector`. */
async function renderedFonts(page: Page, selector: string) {
	const cdp = await page.context().newCDPSession(page);
	await cdp.send('DOM.enable');
	await cdp.send('CSS.enable');
	const { root } = await cdp.send('DOM.getDocument');
	const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector });
	const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
	await cdp.detach();
	return fonts;
}

test('the paid result heading hangs its "¡" in the display font and aligns its lines', async ({ page }, testInfo) => {
	await buyAndPay(page);
	const heading = page.getByRole('heading', { level: 1, name: '¡Listo! Tu compra está confirmada', exact: true });
	await expect(heading).toBeVisible({ timeout: 20_000 });
	await page.evaluate(() => document.fonts.ready);

	for (const viewport of [
		{ width: 1280, height: 900 },
		{ width: 390, height: 844 }
	]) {
		await page.setViewportSize(viewport);
		const { mark, headingFont, lineStarts } = await measureHeading(page);
		await testInfo.attach(`heading-${viewport.width}`, { body: await page.locator('section.page').screenshot(), contentType: 'image/png' });
		expect(mark?.text).toBe('¡');
		expect(mark?.font).toBe(headingFont);
		expect(lineStarts.length).toBeGreaterThanOrEqual(2);
		const [first, ...rest] = lineStarts as [number, ...number[]];
		for (const start of rest) expect(Math.abs(start - first), `line starts ${lineStarts.join(', ')}`).toBeLessThanOrEqual(1);
		// The mark hangs entirely before the first letter.
		expect(Math.abs(mark!.right - first)).toBeLessThanOrEqual(1);
	}

	// The mark is drawn by the same web font as the letters, never by a system fallback.
	const markFonts = await renderedFonts(page, 'h1 .hanging-punctuation');
	const letterFonts = await renderedFonts(page, 'h1');
	expect(markFonts).toHaveLength(1);
	expect(markFonts[0]!.isCustomFont).toBe(true);
	expect(letterFonts.map((font) => font.familyName)).toContain(markFonts[0]!.familyName);
});
