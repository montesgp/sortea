import { createRequire } from 'node:module';
import { expect, test, type Page } from '@playwright/test';
import { campaignOpen } from './campaign-state';
import { declareAdultIfAsked } from './checkout-consents';

// odd/tasks/tracking-links.md S1-S4: a link per video created in the back office, a visit
// through it remembered in a cookie (the address loses its code), the purchase that follows
// attributed to the link, and the link's performance in the back office. Only a campaign that
// accepts participations takes the purchase, so its counts are checked with E2E_CAMPAIGN_OPEN=1.
const password = process.env.E2E_ADMIN_PASSWORD;
test.skip(!password, 'Set E2E_ADMIN_PASSWORD to the password printed by the seed');

// The web package does not depend on a database client; the db package's own is used.
const postgres = createRequire(new URL('../../../packages/db/package.json', import.meta.url))('postgres') as (
	url: string,
	options?: { max?: number }
) => { unsafe<T>(query: string, params: unknown[]): Promise<T[]>; end(): Promise<void> };
const databaseUrl = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

async function signIn(page: Page) {
	await page.goto('/admin/login?next=/admin/campanas');
	await page.getByLabel('Email').fill('owner@motogarage.local');
	await page.getByLabel('Contraseña').fill(password!);
	await page.getByRole('button', { name: 'Ingresar' }).click();
	await page.waitForURL((url) => url.pathname === '/admin/campanas');
}

async function attributionOf(reference: string) {
	const sql = postgres(databaseUrl, { max: 1 });
	try {
		return await sql.unsafe<{ code: string; is_last: boolean; source_channel: string | null }>(
			`select l.code, a.is_last, o.source_channel
			from app.orders o
			join app.order_attributions a on a.order_id = o.id
			join app.tracking_links l on l.id = a.tracking_link_id
			where o.reference = $1`,
			[reference]
		);
	} finally {
		await sql.end();
	}
}

test('a purchase made after opening a video link is attributed to that link', async ({ page, browser }) => {
	await signIn(page);
	await page.getByRole('link', { name: /Honda Tornado/ }).click();
	await page.getByRole('link', { name: 'Links de seguimiento' }).click();
	await expect(page.getByRole('heading', { name: 'Links de seguimiento' })).toBeVisible();

	const name = `Reel e2e ${Date.now()}`;
	await page.getByLabel('Nombre del video').fill(name);
	await page.getByLabel('Red').selectOption('instagram');
	await page.getByLabel('Nota (opcional)').fill('Prueba automática');
	await page.getByRole('button', { name: 'Crear link' }).click();
	await expect(page.getByRole('status')).toContainText('Link creado');

	const item = page.getByRole('listitem', { name });
	await expect(item.getByText('Instagram')).toBeVisible();
	const shared = await item.getByLabel(`Link de ${name}`).inputValue();
	const url = new URL(shared);
	const code = url.searchParams.get('src')!;
	expect(code).toMatch(/^[a-z0-9]{8}$/);
	expect(url.pathname).toBe('/');

	// A visitor, without the admin session, opens the link from the video.
	const visitor = await (await browser.newContext()).newPage();
	const landing = await visitor.goto(`/?src=${code}`);
	expect(landing!.request().redirectedFrom()).not.toBeNull();
	expect((await landing!.request().redirectedFrom()!.response())!.status()).toBe(303);
	expect(new URL(visitor.url()).search).toBe('');
	const cookie = (await visitor.context().cookies()).find((candidate) => candidate.name === 'sortea_src');
	expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/' });
	expect(decodeURIComponent(cookie!.value)).toContain(`"${code}"`);
	expect(cookie!.expires).toBeGreaterThan(Date.now() / 1000);

	// An unknown code is ignored the same way: the address loses it and nothing is added.
	await visitor.goto('/?src=zzzz9999');
	expect(new URL(visitor.url()).search).toBe('');
	const after = (await visitor.context().cookies()).find((candidate) => candidate.name === 'sortea_src');
	expect(decodeURIComponent(after!.value)).not.toContain('zzzz9999');

	await visitor.goto('/tienda');
	await visitor.getByRole('article').filter({ hasText: 'Manual técnico' }).getByRole('button', { name: 'Agregar al carrito' }).click();
	await visitor.getByRole('link', { name: 'Continuar con la compra' }).click();
	const email = `e2e-link-${Date.now()}@example.com`;
	await visitor.getByLabel('Nombre', { exact: true }).fill('Prueba');
	await visitor.getByLabel('Apellido').fill('Link');
	await visitor.getByLabel('Número').fill(String(20_000_000 + Math.floor(Math.random() * 9_000_000)));
	await visitor.getByLabel('Email', { exact: true }).fill(email);
	await visitor.getByLabel('Repetí el email').fill(email);
	await visitor.getByLabel('Provincia', { exact: true }).selectOption('Buenos Aires');
	await visitor.getByLabel('Ciudad', { exact: true }).fill('Arrecifes');
	await visitor.getByLabel(/Acepto los/).check();
	await visitor.getByLabel(/Leí la/).check();
	await declareAdultIfAsked(visitor);
	await visitor.getByRole('button', { name: /Ir a pagar/ }).click();
	await expect(visitor.getByRole('heading', { name: 'Simulador de pagos' })).toBeVisible();
	await visitor.getByRole('button', { name: 'Aprobar pago' }).click();
	await expect(visitor.getByRole('heading', { name: /compra está confirmada/ })).toBeVisible({ timeout: 20_000 });
	const reference = (await visitor.locator('.code').first().textContent())!.trim();

	expect(await attributionOf(reference)).toEqual([{ code, is_last: true, source_channel: null }]);
	await visitor.context().close();

	// Archived, the link stays listed with its code and stops taking visits.
	await page.reload();
	await page.getByRole('listitem', { name }).getByRole('button', { name: 'Archivar' }).click();
	await expect(page.getByRole('status')).toContainText('Link archivado');
	await expect(page.getByRole('region', { name: 'Archivados' }).getByRole('listitem', { name })).toContainText(code);

	// S4: the archived link keeps its row in the performance view, credited with the purchase.
	await page.getByRole('navigation', { name: 'Links de seguimiento' }).getByRole('link', { name: 'Rendimiento' }).click();
	await expect(page.getByRole('heading', { name: 'Rendimiento de los links' })).toBeVisible();
	await expect(page.getByText(/«Último» más «Sin link» da el total de la campaña/)).toBeVisible();
	const row = page.getByRole('region', { name: 'Por video' }).getByRole('row', { name });
	await expect(row).toContainText('Archivado');
	const cells = row.getByRole('cell');
	await expect(cells).toHaveCount(10);
	if (campaignOpen) {
		// Participó and Último: one purchase by one person, in pesos.
		for (const index of [0, 5]) await expect(cells.nth(index)).toHaveText('1');
		for (const index of [1, 6]) await expect(cells.nth(index)).toHaveText('1');
		await expect(cells.nth(3)).toContainText('$');
	}
	await page.getByLabel('Ordenar por').selectOption('chances');
	await page.getByLabel('según').selectOption('last');
	await expect(row).toBeVisible();
	await expect(page.getByRole('region', { name: 'Por red' }).getByRole('row', { name: 'Total de la campaña' })).toBeVisible();

	await page.getByRole('link', { name: 'Comparar campañas' }).click();
	await expect(page.getByRole('heading', { name: 'Rendimiento de las campañas' })).toBeVisible();
	const campaign = page.getByRole('row', { name: /Honda Tornado/ });
	await expect(campaign).toBeVisible();
	if (campaignOpen) await expect(campaign.getByRole('cell').nth(7)).not.toHaveText('0');
});
