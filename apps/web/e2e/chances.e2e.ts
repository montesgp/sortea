import { expect, test, type Locator, type Page } from '@playwright/test';
import { campaignBand, campaignOpen, expectDeclaredCampaignState } from './campaign-state';

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
	test.skip(campaignOpen, 'The rules of an open campaign are locked: the table is read-only and a change needs an announced version');
	await signIn(page);
	await openCampaign(page);

	await expect(table(page).getByText(/Cada chance es un cupón numerado/)).toBeVisible();
	await expect(table(page).getByLabel(/Chances por unidad: Manual técnico MotoGarage/)).toHaveValue('14');
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
		await setChances(page, /Chances por unidad: Checklist de viaje/, '3');
	}

	await page.getByRole('link', { name: 'Productos' }).click();
	await page.getByRole('link', { name: 'Checklist de viaje' }).click();
	await expect(page.getByRole('region', { name: 'Chances en campañas' })).toContainText('No suma chances en ninguna campaña');
});

// Locked rules of an open campaign are shown, not edited. The local demo publishes progressive
// chances (feedback 2026-10-30, S2): the price per chance falls as the price rises.
test('an open campaign shows its locked chances per product read-only', async ({ page }) => {
	test.skip(!password, 'Set E2E_ADMIN_PASSWORD to the password printed by the seed');
	test.skip(!campaignOpen, 'Only an open campaign has locked rules; set E2E_CAMPAIGN_OPEN=1');
	await signIn(page);
	await openCampaign(page);

	const perUnit = (product: string) => table(page).getByRole('row').filter({ hasText: product }).getByRole('cell').last();
	await expect(perUnit('Calcomanía MotoGarage')).toHaveText('1');
	await expect(perUnit('Checklist de viaje')).toHaveText('3');
	await expect(perUnit('Remera MotoGarage')).toHaveText('11');
	await expect(perUnit('Manual técnico MotoGarage')).toHaveText('14');
	await expect(table(page).getByRole('spinbutton')).toHaveCount(0);
});

// FR-CAMP-05: chances are promised only while a campaign accepts participations. The seeded
// campaign keeps its approvals pending (none promised); an open one (approvals recorded, or the
// local demo mode, ADR 0013) promises them on the cards and in the cart.
test('the shop and the cart promise chances only while a campaign accepts participations (FR-CAMP-05)', async ({ page }) => {
	await page.goto('/tienda', { waitUntil: 'networkidle' });
	await expectDeclaredCampaignState(campaignBand(page));
	const card = page.getByRole('article').filter({ hasText: 'Manual técnico' });
	await expect(card.getByText(/^\$/)).toBeVisible();
	await expectPromise(page, card);

	await card.getByRole('button', { name: 'Agregar al carrito' }).click();
	await expect(page).toHaveURL(/\/carrito$/);
	const line = page.getByRole('region', { name: 'Productos en tu carrito' }).getByRole('listitem').filter({ hasText: 'Manual técnico' });
	await expect(line.getByText(/por unidad/)).toBeVisible();
	await expectPromise(page, line);
});

/**
 * The promise of `scope` (a product card or a cart line), checked twice:
 * - on the page: shown while the campaign is open;
 * - on the same page rendered by the server alone (JavaScript off, same session): chances come
 *   from the server load, so that view is final once loaded and an absence there is real, never
 *   a check that ran before they rendered. Open, it must hold them too, which proves the premise.
 */
async function expectPromise(page: Page, scope: Locator) {
	if (campaignOpen) await expect(scope.getByText(/chances? para/).first()).toBeVisible();
	const server = await page.context().browser()!.newContext({ javaScriptEnabled: false, storageState: await page.context().storageState() });
	try {
		const view = await server.newPage();
		await view.goto(page.url());
		await expect(view.getByText('Manual técnico').first(), 'the server-rendered page holds the product').toBeVisible();
		const promises = await view.getByText(/chances? para/).count();
		if (campaignOpen) expect(promises, 'the server renders the promises of an open campaign').toBeGreaterThan(0);
		else expect(promises).toBe(0);
	} finally {
		await server.close();
	}
}
