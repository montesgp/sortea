import type { Page } from '@playwright/test';

/** The adult declaration label of the checkout (S11), shown only when the cart gives chances. */
export const ADULT_DECLARATION = /Declaro ser mayor de 18 años/;

/** Checks the adult declaration when the checkout asks for it; carts without chances never show it. */
export async function declareAdultIfAsked(page: Page) {
	const declaration = page.getByLabel(ADULT_DECLARATION);
	if (await declaration.count()) await declaration.check();
}
