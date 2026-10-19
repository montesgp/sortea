import { expect, test, type Page } from '@playwright/test';

// Feedback 2026-10-18b (S2, S3): the campaign page and the home show the
// products chosen in the back office, or every product for sale when none is.

const password = process.env.E2E_ADMIN_PASSWORD;
const all = ['Manual técnico MotoGarage', 'Checklist de viaje', 'Calcomanía MotoGarage', 'Remera MotoGarage'];

const campaignProducts = (page: Page) => page.getByRole('region', { name: 'Productos' }).getByRole('article');
const homeProducts = (page: Page) => page.getByRole('region', { name: 'De la tienda' }).getByRole('article');

async function expectProducts(products: ReturnType<typeof campaignProducts>, names: string[]) {
	await expect(products).toHaveCount(names.length);
	for (const name of names) await expect(products.filter({ hasText: name })).toHaveCount(1);
}

async function signIn(page: Page) {
	await page.goto('/admin/login');
	await page.getByLabel('Email').fill('owner@motogarage.local');
	await page.getByLabel('Contraseña').fill(password!);
	await page.getByRole('button', { name: 'Ingresar' }).click();
	await page.waitForURL(/\/admin$/);
}

test('with nothing chosen, the campaign and the home show every product for sale', async ({ page }) => {
	await page.goto('/sorteos/tornado-300', { waitUntil: 'networkidle' });
	await expectProducts(campaignProducts(page), all);
	await page.goto('/', { waitUntil: 'networkidle' });
	await expectProducts(homeProducts(page), all);
});

test('the campaign editor chooses what its page shows', async ({ page }) => {
	test.skip(!password, 'Set E2E_ADMIN_PASSWORD to the password printed by the seed');
	await signIn(page);
	await page.getByRole('link', { name: 'Campañas' }).click();
	await page.getByRole('link', { name: /Honda Tornado/ }).click();
	await page.waitForLoadState('networkidle');
	const panel = page.getByRole('region', { name: 'Productos en la campaña' });
	try {
		await panel.getByLabel('Remera MotoGarage').check();
		await panel.getByLabel('Manual técnico MotoGarage').check();
		await panel.getByRole('button', { name: 'Guardar productos' }).click();
		await expect(panel.getByRole('status')).toHaveText('Productos de la campaña guardados');
		await page.goto('/sorteos/tornado-300', { waitUntil: 'networkidle' });
		await expectProducts(campaignProducts(page), ['Manual técnico MotoGarage', 'Remera MotoGarage']);
	} finally {
		await page.goBack({ waitUntil: 'networkidle' });
		for (const name of all) await page.getByRole('region', { name: 'Productos en la campaña' }).getByLabel(name).uncheck();
		await page.getByRole('region', { name: 'Productos en la campaña' }).getByRole('button', { name: 'Guardar productos' }).click();
		await expect(page.getByRole('region', { name: 'Productos en la campaña' }).getByRole('status')).toHaveText('La campaña muestra todos los productos');
	}
	await page.goto('/sorteos/tornado-300', { waitUntil: 'networkidle' });
	await expectProducts(campaignProducts(page), all);
});

test('the site editor chooses what the home shows', async ({ page }) => {
	test.skip(!password, 'Set E2E_ADMIN_PASSWORD to the password printed by the seed');
	await signIn(page);
	await page.goto('/admin/sitio?tab=inicio', { waitUntil: 'networkidle' });
	const choose = async (checked: string[]) => {
		const group = page.getByRole('group', { name: 'Productos en la página de inicio' });
		for (const name of all) await group.getByLabel(name).setChecked(checked.includes(name));
		await page.getByRole('button', { name: 'Guardar y publicar' }).click();
		await page.waitForLoadState('networkidle');
	};
	try {
		await choose(['Calcomanía MotoGarage']);
		await page.goto('/', { waitUntil: 'networkidle' });
		await expectProducts(homeProducts(page), ['Calcomanía MotoGarage']);
	} finally {
		await page.goto('/admin/sitio?tab=inicio', { waitUntil: 'networkidle' });
		await choose([]);
	}
	await page.goto('/', { waitUntil: 'networkidle' });
	await expectProducts(homeProducts(page), all);
});
