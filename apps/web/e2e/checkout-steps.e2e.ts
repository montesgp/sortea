import { expect, test, type Page } from '@playwright/test';
import { fillStepOne, PAY_BUTTON, STEP_ONE, STEP_TWO } from './checkout-form';

// Checkout in two steps (S1-S5) on a phone: step 1 is where the purchase is sent, step 2 the
// last details; Continuar and Volver are always enabled and the browser's Back and Forward move
// between the steps. What was typed is kept 24 hours on this device, with its step, until the
// purchase is done or the buyer erases it with "Borrar mis datos".

const PHONE = { width: 390, height: 844 };
test.use({ viewport: PHONE });

const DRAFT = 'sortea_checkout_draft';

async function toCheckout(page: Page) {
	await page.goto('/tienda', { waitUntil: 'networkidle' });
	await page.getByRole('article').filter({ hasText: 'Manual técnico' }).getByRole('button', { name: 'Agregar al carrito' }).click();
	await expect(page).toHaveURL(/\/carrito$/);
	await page.goto('/checkout', { waitUntil: 'networkidle' });
}

const stepOneHeading = (page: Page) => page.getByRole('heading', { name: STEP_ONE });
const stepTwoHeading = (page: Page) => page.getByRole('heading', { name: STEP_TWO });

async function expectStep(page: Page, step: 1 | 2) {
	await expect(page.getByText(`Paso ${step} de 2`, { exact: true })).toBeVisible();
	await expect(step === 1 ? stepOneHeading(page) : stepTwoHeading(page)).toBeVisible();
	await expect(step === 1 ? stepTwoHeading(page) : stepOneHeading(page)).toBeHidden();
}

async function fillStepTwo(page: Page) {
	await page.getByLabel('WhatsApp / teléfono').fill('+54 9 341 555-1234');
	await page.getByLabel('Número').fill('30123456');
	await page.getByLabel('Provincia', { exact: true }).selectOption('Santa Fe');
	await page.getByLabel('Ciudad', { exact: true }).fill('Rosario');
}

test.beforeEach(async ({ context }) => {
	await context.clearCookies();
});

test('step 1 checks itself in place, helps with the email, and Back and Forward move between the steps', async ({ page }) => {
	await toCheckout(page);
	await expectStep(page, 1);
	// The summary is compact on top; its lines open on request.
	const summary = page.getByRole('complementary', { name: 'Resumen del pedido' });
	await expect(summary).toContainText('Total');
	await expect(summary.getByText(/Manual técnico/)).toBeHidden();
	await summary.getByRole('button', { name: 'Ver detalle' }).click();
	await expect(summary.getByText(/Manual técnico/)).toBeVisible();

	// Continuar is never a disabled grey button: it says what is missing and focuses it.
	const proceed = page.getByRole('button', { name: 'Continuar' });
	await expect(proceed).toBeEnabled();
	await proceed.click();
	await expectStep(page, 1);
	await expect(page.locator('#email-error')).toHaveText('Ingresá un email válido');
	await expect(page.locator('#firstName-error')).toHaveText('Ingresá tu nombre');
	await expect(page.locator('#lastName-error')).toHaveText('Ingresá tu apellido');
	await expect(page.getByLabel('Email', { exact: true })).toBeFocused();

	// A mistyped common domain is pointed out and fixed in one tap.
	const email = page.getByLabel('Email', { exact: true });
	await email.fill('juana@gmial.com');
	await page.getByLabel('Nombre', { exact: true }).fill('Juana');
	await expect(page.getByText('¿Quisiste decir juana@gmail.com?')).toBeVisible();
	await page.getByRole('button', { name: 'juana@gmail.com' }).click();
	await expect(email).toHaveValue('juana@gmail.com');
	await expect(page.getByText(/Quisiste decir/)).toHaveCount(0);
	await expect(page.locator('#firstName-error')).toHaveCount(0);
	await page.getByLabel('Apellido', { exact: true }).fill('Pérez');

	await proceed.click();
	await expectStep(page, 2);
	await expect(stepTwoHeading(page)).toBeFocused();
	await expect(page.getByText('Te lo enviamos a juana@gmail.com')).toBeVisible();
	await expect(page.getByLabel('WhatsApp / teléfono')).toHaveAttribute('autocomplete', 'tel');
	await expect(page.getByText('Usamos tus datos para gestionar tu compra, enviarte lo que compraste y contactarte si ganás, según las bases.')).toBeVisible();
	await expect(page.getByRole('button', { name: PAY_BUTTON })).toBeVisible();
	// The country is the organization's unless the buyer asks to change it.
	await expect(page.getByLabel('País')).toBeHidden();
	await page.getByRole('button', { name: 'Cambiar país' }).click();
	await expect(page.getByLabel('País')).toBeVisible();
	await expect(page.getByLabel('País')).toBeFocused();
	await page.getByLabel('WhatsApp / teléfono').fill('+54 9 341 555-1234');

	// The browser's Back returns to step 1 with what was typed, and Forward to step 2.
	await page.goBack();
	await expectStep(page, 1);
	await expect(page).toHaveURL(/\/checkout$/);
	await expect(email).toHaveValue('juana@gmail.com');
	await expect(page.getByLabel('Nombre', { exact: true })).toHaveValue('Juana');
	await expect(page.getByLabel('Apellido', { exact: true })).toHaveValue('Pérez');
	await page.goForward();
	await expectStep(page, 2);
	await expect(page.getByLabel('WhatsApp / teléfono')).toHaveValue('+54 9 341 555-1234');

	// Volver keeps everything too; "Cambiar" goes to step 1 with the email focused.
	await page.getByRole('button', { name: 'Volver', exact: true }).click();
	await expectStep(page, 1);
	await expect(stepOneHeading(page)).toBeFocused();
	await page.getByRole('button', { name: 'Continuar' }).click();
	await expectStep(page, 2);
	await page.getByRole('button', { name: 'Cambiar', exact: true }).click();
	await expectStep(page, 1);
	await expect(email).toBeFocused();
	await page.keyboard.press('Enter');
	// Enter in step 1 is Continuar.
	await expectStep(page, 2);
});

test('the draft comes back after a reload and after the browser is closed, on its step, without consents', async ({ page, context, browser }) => {
	await toCheckout(page);
	await fillStepOne(page, { email: 'juana@example.com', firstName: 'Juana', lastName: 'Pérez' });
	await fillStepTwo(page);
	await page.getByLabel(/Acepto los/).check();

	await page.reload({ waitUntil: 'networkidle' });
	await expectStep(page, 2);
	await expect(page.getByLabel('WhatsApp / teléfono')).toHaveValue('+54 9 341 555-1234');
	await expect(page.getByLabel('Número')).toHaveValue('30123456');
	await expect(page.getByLabel('Provincia', { exact: true })).toHaveValue('Santa Fe');
	await expect(page.getByLabel('Ciudad', { exact: true })).toHaveValue('Rosario');
	await expect(page.getByText('Te lo enviamos a juana@example.com')).toBeVisible();
	await expect(page.getByLabel(/Acepto los/)).not.toBeChecked();
	const stored = await page.evaluate((key) => localStorage.getItem(key), DRAFT);
	expect(stored).not.toMatch(/terms|privacy|adultDeclaration|emailConfirm/);

	// Another browser session on the same device: the cookies and this site's storage are kept.
	const state = await context.storageState();
	const reopened = await browser.newContext({ storageState: state, viewport: PHONE });
	const again = await reopened.newPage();
	await again.goto('/checkout', { waitUntil: 'networkidle' });
	await expectStep(again, 2);
	await expect(again.getByLabel('Ciudad', { exact: true })).toHaveValue('Rosario');
	await again.getByRole('button', { name: 'Volver', exact: true }).click();
	await expect(again.getByLabel('Nombre', { exact: true })).toHaveValue('Juana');
	await expect(again.getByLabel('Email', { exact: true })).toHaveValue('juana@example.com');

	// After 24 hours the draft is not offered any longer, and is removed.
	await again.evaluate((key) => {
		const draft = JSON.parse(localStorage.getItem(key)!);
		localStorage.setItem(key, JSON.stringify({ ...draft, savedAt: Date.now() - 24 * 60 * 60 * 1000 - 1000 }));
	}, DRAFT);
	await again.reload({ waitUntil: 'networkidle' });
	await expectStep(again, 1);
	await expect(again.getByLabel('Email', { exact: true })).toHaveValue('');
	expect(await again.evaluate((key) => localStorage.getItem(key), DRAFT)).toBeNull();
	await reopened.close();
});

test('"Borrar mis datos" empties the form and this device\'s copy', async ({ page }) => {
	await toCheckout(page);
	await fillStepOne(page, { email: 'juana@example.com', firstName: 'Juana', lastName: 'Pérez' });
	await fillStepTwo(page);
	await page.getByRole('button', { name: 'Borrar mis datos' }).click();
	await expectStep(page, 1);
	await expect(page.getByText('Borramos tus datos de este dispositivo.')).toBeVisible();
	await expect(page.getByLabel('Email', { exact: true })).toHaveValue('');
	await expect(page.getByLabel('Email', { exact: true })).toBeFocused();
	await expect(page.getByLabel('Nombre', { exact: true })).toHaveValue('');
	expect(await page.evaluate((key) => localStorage.getItem(key), DRAFT)).toBeNull();

	await page.reload({ waitUntil: 'networkidle' });
	await expectStep(page, 1);
	await expect(page.getByLabel('Nombre', { exact: true })).toHaveValue('');
	await page.getByRole('button', { name: 'Continuar' }).click();
	await expectStep(page, 1);
	await expect(page.getByLabel('WhatsApp / teléfono')).toBeHidden();
});

test('a refused submit opens the step that holds the first field to fix', async ({ page }) => {
	await toCheckout(page);
	await fillStepOne(page, { email: 'juana@example.com', firstName: 'Juana', lastName: 'Pérez' });
	await fillStepTwo(page);
	// Consents unchecked: the server refuses, and the page opens on step 2 with the errors there.
	await page.getByRole('button', { name: PAY_BUTTON }).click();
	await expect(page.getByRole('alert')).toHaveText('Revisá los datos marcados');
	await expectStep(page, 2);
	await expect(page.getByText('Necesitamos que aceptes los términos para vender')).toBeVisible();
	await expect(page.getByLabel(/Acepto los/)).toBeFocused();

	// The server finds the email wrong (here the request is changed on its way): step 1 opens.
	await page.route('**/checkout', async (route) => {
		const request = route.request();
		if (request.method() !== 'POST') return route.continue();
		await route.continue({ postData: request.postData()!.replace(/email=[^&]*/, 'email=juana%40example') });
	});
	await page.getByRole('button', { name: PAY_BUTTON }).click();
	await expect(page.getByRole('alert')).toHaveText('Revisá los datos marcados');
	await expectStep(page, 1);
	await expect(page.locator('#email-error')).toHaveText('Ingresá un email válido');
	await expect(page.getByLabel('Email', { exact: true })).toBeFocused();
	await page.unroute('**/checkout');
	await page.getByLabel('Email', { exact: true }).fill('juana@example.com');
	await page.getByRole('button', { name: 'Continuar' }).click();
	await expectStep(page, 2);
	await expect(page.getByLabel('Ciudad', { exact: true })).toHaveValue('Rosario');
});
