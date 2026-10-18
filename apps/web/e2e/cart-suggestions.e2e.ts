import { expect, test } from '@playwright/test';

// S3 (feedback 2026-10-18): the cart suggests every product it does not hold,
// including the T-shirt, which is added through its size chooser.

test('the cart suggests the T-shirt and adds the size the buyer picks', async ({ page, context }) => {
	await context.clearCookies();
	await page.goto('/tienda', { waitUntil: 'networkidle' });
	await page.getByRole('article').filter({ hasText: 'Manual técnico' }).getByRole('button', { name: 'Agregar al carrito' }).click();
	await expect(page).toHaveURL(/\/carrito$/);
	await page.waitForLoadState('networkidle');

	const suggestions = page.getByRole('region', { name: '¿Querés sumar algo?' });
	for (const name of ['Remera MotoGarage', 'Calcomanía MotoGarage', 'Checklist de viaje']) {
		await expect(suggestions.getByRole('listitem').filter({ hasText: name })).toHaveCount(1);
	}
	await expect(suggestions.getByRole('listitem').filter({ hasText: 'Manual técnico' })).toHaveCount(0);

	await suggestions.getByRole('button', { name: 'Elegir talle de Remera MotoGarage' }).click();
	const chooser = page.getByRole('dialog', { name: 'Remera MotoGarage' });
	await chooser.getByRole('radio', { name: 'Talle L' }).check();
	await chooser.getByRole('button', { name: 'Agregar', exact: true }).click();
	await expect(chooser.getByRole('status')).toHaveText('Agregaste 1 × Talle L al carrito.');
	await chooser.getByRole('button', { name: 'Seguir comprando' }).click();

	const lines = page.getByRole('region', { name: 'Productos en tu carrito' });
	await expect(lines.getByRole('listitem').filter({ hasText: 'Remera MotoGarage · Talle L' })).toHaveCount(1);
	await expect(suggestions.getByRole('listitem').filter({ hasText: 'Remera MotoGarage' })).toHaveCount(0);
});
