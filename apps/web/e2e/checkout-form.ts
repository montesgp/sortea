import { expect, type Page } from '@playwright/test';

/** The checkout's pay button (checkout in two steps S2): "Pagar $X con Mercado Pago". */
export const PAY_BUTTON = /^Pagar .+ con Mercado Pago$/;

export const STEP_ONE = /¿A dónde te enviamos tu compra\?/;
export const STEP_TWO = /Últimos datos/;

/** Continuar from step 1, which has to be complete, to step 2. */
export async function continueToStepTwo(page: Page) {
	await page.getByRole('button', { name: 'Continuar' }).click();
	await expect(page.getByRole('heading', { name: STEP_TWO })).toBeVisible();
}

/** Fills step 1 of the checkout (email, nombre, apellido) and continues to step 2. */
export async function fillStepOne(page: Page, buyer: { email: string; firstName?: string; lastName?: string }) {
	// Continuar and Volver appear once the page is interactive; until then both steps show as one page.
	await expect(page.getByRole('button', { name: /^(Continuar|Volver)$/ })).toBeVisible();
	await page.waitForLoadState('networkidle');
	// A draft kept on this device may open the checkout on step 2 (T2): Volver keeps it and returns.
	if (await page.getByRole('heading', { name: STEP_TWO }).isVisible()) await page.getByRole('button', { name: 'Volver', exact: true }).click();
	await expect(page.getByRole('heading', { name: STEP_ONE })).toBeVisible();
	await page.getByLabel('Email', { exact: true }).fill(buyer.email);
	await page.getByLabel('Nombre', { exact: true }).fill(buyer.firstName ?? 'Prueba');
	await page.getByLabel('Apellido', { exact: true }).fill(buyer.lastName ?? 'Automática');
	await continueToStepTwo(page);
}
