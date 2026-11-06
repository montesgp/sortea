import { expect, test, type Page } from '@playwright/test';

// Seeded local accounts share one password (SEED_ADMIN_PASSWORD in .env).
const password = process.env.E2E_ADMIN_PASSWORD;
test.skip(!password, 'Set E2E_ADMIN_PASSWORD to the password printed by the seed');

async function openFaqs(page: Page) {
	await page.goto('/admin/sitio?tab=preguntas');
	await page.waitForLoadState('networkidle');
}

async function signIn(page: Page) {
	await page.goto('/admin/login');
	await page.getByLabel('Email').fill('owner@motogarage.local');
	await page.getByLabel('Contraseña').fill(password!);
	await page.getByRole('button', { name: 'Ingresar' }).click();
	await expect(page.getByRole('heading', { name: 'Resumen' })).toBeVisible();
	await openFaqs(page);
}

const items = (page: Page) => page.locator('article.faq');

test('site FAQs are numbered from 1 and a new one gets the next number (S1)', async ({ page }) => {
	await signIn(page);
	const count = await items(page).count();
	expect(count).toBeGreaterThan(0);
	const orders: number[] = [];
	for (let index = 0; index < count; index++) {
		const item = items(page).nth(index);
		await expect(item.locator('summary .faq-number')).toHaveText(String(index + 1));
		orders.push(Number(await item.getByLabel('Orden').inputValue()));
	}
	expect(Math.min(...orders)).toBeGreaterThanOrEqual(1);
	await expect(page.locator('form.new-faq').getByLabel('Orden')).toHaveValue(String(Math.max(...orders) + 1));
});

test('site FAQs start collapsed and open and close with the keyboard (S2)', async ({ page }) => {
	await signIn(page);
	const count = await items(page).count();
	for (let index = 0; index < count; index++) {
		const item = items(page).nth(index);
		await expect(item.locator('summary')).toBeVisible();
		await expect(item.getByLabel('Respuesta')).toBeHidden();
	}

	const first = items(page).first();
	const question = await first.getByLabel('Pregunta').inputValue();
	await expect(first.locator('summary')).toContainText(question);
	await first.locator('summary').focus();
	await page.keyboard.press('Enter');
	await expect(first.getByLabel('Respuesta')).toBeVisible();
	await expect(first.getByRole('button', { name: 'Guardar pregunta' })).toBeVisible();
	await page.keyboard.press('Space');
	await expect(first.getByLabel('Respuesta')).toBeHidden();
});

test('an expanded FAQ still saves, and a rejected save reopens it with the message (S2)', async ({ page }) => {
	await signIn(page);
	const first = () => items(page).first();
	const original = await first().getByLabel('Respuesta').inputValue();
	const edited = `${original} (e2e ${Date.now()})`;

	await first().locator('summary').click();
	await first().getByLabel('Respuesta').fill(edited);
	await first().getByRole('button', { name: 'Guardar pregunta' }).click();
	await expect(page.getByRole('status')).toContainText('Pregunta guardada');
	try {
		await expect(first().getByLabel('Respuesta')).toHaveValue(edited);

		// The browser accepts a short answer; the API rejects it and the item opens to show why.
		await page.waitForLoadState('networkidle');
		await first().locator('summary').click();
		await first().getByLabel('Respuesta').fill('Sí.');
		await first().getByRole('button', { name: 'Guardar pregunta' }).click();
		await expect(first().getByRole('alert')).toBeVisible();
		await expect(first().getByLabel('Respuesta')).toBeVisible();
	} finally {
		await openFaqs(page);
		await first().locator('summary').click();
		await first().getByLabel('Respuesta').fill(original);
		await first().getByRole('button', { name: 'Guardar pregunta' }).click();
		await expect(page.getByRole('status')).toContainText('Pregunta guardada');
	}
	await expect(first().getByLabel('Respuesta')).toHaveValue(original);
	await expect(first().getByLabel('Respuesta')).toBeHidden();
});

test('a newly added FAQ opens expanded, last and with the next number (S1, S2)', async ({ page }) => {
	const question = `¿Pregunta e2e-${Date.now()}?`;
	await signIn(page);
	const count = await items(page).count();
	const form = page.locator('form.new-faq');
	await form.getByLabel('Pregunta').fill(question);
	await form.getByLabel('Respuesta').fill('Respuesta de la prueba automática.');
	await form.getByRole('button', { name: 'Agregar pregunta' }).click();
	await expect(page.getByRole('status')).toContainText('Pregunta agregada');

	const added = items(page).filter({ has: page.locator(`input[value="${question}"]`) });
	try {
		await expect(items(page)).toHaveCount(count + 1);
		await expect(items(page).last()).toContainText(question);
		await expect(added.locator('summary .faq-number')).toHaveText(String(count + 1));
		await expect(added.getByLabel('Respuesta')).toBeVisible();
		await expect(items(page).first().getByLabel('Respuesta')).toBeHidden();
	} finally {
		await page.waitForLoadState('networkidle');
		if (!(await added.getByRole('button', { name: 'Borrar' }).isVisible())) await added.locator('summary').click();
		await added.getByRole('button', { name: 'Borrar' }).click();
		await expect(page.getByRole('status')).toContainText('Pregunta borrada');
	}
	await expect(page.locator(`input[value="${question}"]`)).toHaveCount(0);
});
