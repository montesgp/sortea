import { expect, test, type Page } from '@playwright/test';
import { campaignOpen, expectDeclaredCampaignState } from './campaign-state';

// Chances per product (feedback 2026-10-15, S5): set per variant in the
// campaign rules while they are editable and visible on the product. Buyers
// see chances only from locked rules of a campaign accepting participations
// (the counts are covered by apps/api/test/chances.test.ts). The seeded campaign
// keeps its approvals pending; the local demo mode opens it, and the runner
// declares which state applies with E2E_CAMPAIGN_OPEN (campaign-state.ts).

const password = process.env.E2E_ADMIN_PASSWORD;

async function signIn(page: Page) {
	await page.goto('/admin/login');
	await page.getByLabel('Email').fill('owner@motogarage.local');
	await page.getByLabel('Contraseña').fill(password!);
	await page.getByRole('button', { name: 'Ingresar' }).click();
	await expect(page.getByRole('heading', { name: 'Resumen' })).toBeVisible();
}

async function openCampaign(page: Page) {
	await page.getByRole('link', { name: 'Campañas' }).click();
	await page.getByRole('link', { name: /Honda Tornado/ }).click();
	await page.waitForLoadState('networkidle');
}

const table = (page: Page) => page.getByRole('region', { name: 'Chances por producto' });

async function setChances(page: Page, product: RegExp, value: string) {
	await table(page).getByLabel(product).fill(value);
	await table(page).getByRole('button', { name: 'Guardar chances' }).click();
	await expect(table(page).getByRole('status')).toHaveText('Chances guardadas');
	await page.waitForLoadState('networkidle');
}

test('the owner sets chances per product in the campaign and sees them on the product', async ({ page }) => {
	test.skip(!password, 'Set E2E_ADMIN_PASSWORD to the password printed by the seed');
	await signIn(page);
	await openCampaign(page);

	await expect(table(page).getByText(/Cada chance es un cupón numerado/)).toBeVisible();
	await expect(table(page).getByLabel(/Chances por unidad: Manual técnico MotoGarage/)).toHaveValue('15');
	await expect(table(page).getByLabel('Máximo de chances por persona')).toBeVisible();

	await setChances(page, /Chances por unidad: Checklist de viaje/, '2');
	try {
		await page.reload({ waitUntil: 'networkidle' });
		await expect(table(page).getByLabel(/Chances por unidad: Checklist de viaje/)).toHaveValue('2');

		await page.getByRole('link', { name: 'Productos' }).click();
		await page.getByRole('link', { name: 'Checklist de viaje' }).click();
		const chances = page.getByRole('region', { name: 'Chances en campañas' });
		await expect(chances).toContainText('2 chances por unidad');
		await expect(chances.getByRole('link', { name: /Honda Tornado/ })).toBeVisible();
	} finally {
		await openCampaign(page);
		// Back to the seeded value.
		await setChances(page, /Chances por unidad: Checklist de viaje/, '5');
	}

	await page.getByRole('link', { name: 'Productos' }).click();
	await page.getByRole('link', { name: 'Checklist de viaje' }).click();
	await expect(page.getByRole('region', { name: 'Chances en campañas' })).toContainText('No suma chances en ninguna campaña');
});

// FR-CAMP-05: chances are promised only while a campaign accepts participations. The seeded
// campaign keeps its approvals pending (none promised); an open one (approvals recorded, or the
// local demo mode, ADR 0013) promises them on the cards and in the cart.
test('the shop and the cart promise chances only while a campaign accepts participations (FR-CAMP-05)', async ({ page }) => {
	await page.goto('/tienda', { waitUntil: 'networkidle' });
	await expect(page.getByRole('article').filter({ hasText: 'Manual técnico' })).toBeVisible();
	await expectDeclaredCampaignState(page.locator('main > section').first());
	// Retrying assertions: an open campaign's promises may render after the products.
	const promises = page.getByText(/chances? para/);
	const expectPromises = () => (campaignOpen ? expect(promises.first()).toBeVisible() : expect(promises).toHaveCount(0));
	await expectPromises();

	await page.getByRole('article').filter({ hasText: 'Manual técnico' }).getByRole('button', { name: 'Agregar al carrito' }).click();
	await expect(page).toHaveURL(/\/carrito$/);
	await page.waitForLoadState('networkidle');
	await expect(page.getByRole('region', { name: 'Productos en tu carrito' })).toContainText('Manual técnico');
	await expectPromises();
});
