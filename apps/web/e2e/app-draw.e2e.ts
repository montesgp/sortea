import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { expect, test, type Page } from '@playwright/test';

// ADR 0024 (odd/tasks/owner-feedback-2026-11-11b.md S10, L14): the prizes the Quiniela left
// vacant are drawn in the back office on a presentation screen. Every coupon without a prize
// spins through the centre with its holder's name cut, the reel stops on the stored winner,
// then on the alternate, and a reload replays the stored draw instead of drawing again.
//
// Seed data never reaches the awarding stage (no approvals), so this spec writes a fresh
// demo campaign of Taller Demo straight into the database: awarding, a Quiniela draw that
// matched no coupon, and 12 coupons from 4 buyers. The in-app draw is append-only, so the
// campaign cannot be removed afterwards: it is archived and labelled as an E2E demo.
const password = process.env.E2E_ADMIN_PASSWORD;
test.skip(!password, 'Set E2E_ADMIN_PASSWORD to the password printed by the seed');
test.describe.configure({ mode: 'serial' });

// The web package does not depend on a database client; the db package's own is used.
const postgres = createRequire(new URL('../../../packages/db/package.json', import.meta.url))('postgres') as (
	url: string,
	options?: { max?: number }
) => { unsafe<T>(query: string, params?: unknown[]): Promise<T[]>; end(): Promise<void> };
const databaseUrl = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

const stamp = Date.now().toString(36);
const prizeTitle = `Moto E2E ${stamp}`;
const buyers = [
	{ firstName: 'Juana', lastName: 'Pérez', masked: 'Ju*** P.' },
	{ firstName: 'Martín', lastName: 'Gómez', masked: 'Ma*** G.' },
	{ firstName: 'Lucía', lastName: 'Ñáñez', masked: 'Lu*** Ñ.' },
	{ firstName: 'Pedro', lastName: 'Ruiz', masked: 'Pe*** R.' }
];
const couponsPerBuyer = 3;
let campaignId = '';

async function withSql<T>(run: (sql: ReturnType<typeof postgres>) => Promise<T>): Promise<T> {
	const sql = postgres(databaseUrl, { max: 1 });
	try {
		return await run(sql);
	} finally {
		await sql.end();
	}
}

async function seedAwardingCampaign() {
	return withSql(async (sql) => {
		const [org] = await sql.unsafe<{ id: string }>(`select id from app.organizations where slug = 'taller-demo'`);
		if (!org) throw new Error('Taller Demo is not seeded');
		const [campaign] = await sql.unsafe<{ id: string }>(
			`insert into app.campaigns (organization_id, slug, title, summary, status, timezone, opens_at, closes_at, is_demo, next_entry_number)
			values ($1, $2, $3, 'Campaña de prueba automática del sorteo en la app.', 'awarding', 'America/Argentina/Buenos_Aires', now() - interval '20 days', now() - interval '2 days', true, $4)
			returning id`,
			[org.id, `e2e-sorteo-app-${stamp}`, `Sorteo en la app E2E ${stamp}`, buyers.length * couponsPerBuyer]
		);
		await sql.unsafe(
			`insert into app.prizes (organization_id, campaign_id, position, kind, title, declared_value_minor, quantity, alternates_count, mechanism)
			values ($1, $2, 1, 'vehicle', $3, 100000000, 1, 1, 'quiniela')`,
			[org.id, campaign!.id, prizeTitle]
		);
		for (const [index, buyer] of buyers.entries()) {
			const [contact] = await sql.unsafe<{ id: string }>(
				`insert into app.contacts (organization_id, first_name, last_name, email) values ($1, $2, $3, $4) returning id`,
				[org.id, buyer.firstName, buyer.lastName, `e2e-sorteo-app-${stamp}-${index}@example.com`]
			);
			const buyerJson = { firstName: buyer.firstName, lastName: buyer.lastName, email: `e2e-sorteo-app-${stamp}-${index}@example.com`, phone: null };
			const pricing = { lines: [], subtotalMinor: 1000, deliveryFeeMinor: 0, totalMinor: 1000, currency: 'ARS', pricedAt: new Date().toISOString() };
			const [order] = await sql.unsafe<{ id: string }>(
				`insert into app.orders (organization_id, reference, access_code_hash, contact_id, buyer, campaign_id, status, currency, subtotal_minor, delivery_fee_minor, total_minor, delivery_method, pricing_snapshot, payment_provider, paid_at, expires_at)
				values ($1, $2, 'e2e', $3, $4::jsonb, $5, 'paid', 'ARS', 1000, 0, 1000, 'digital', $6::jsonb, 'simulator', now() - interval '3 days', now() - interval '3 days')
				returning id`,
				[org.id, `E2E-AD-${stamp}-${index}`.toUpperCase(), contact!.id, JSON.stringify(buyerJson), campaign!.id, JSON.stringify(pricing)]
			);
			for (let coupon = 0; coupon < couponsPerBuyer; coupon++) {
				await sql.unsafe(
					`insert into app.participation_entries (organization_id, campaign_id, entry_number, contact_id, order_id, holder_pseudonym) values ($1, $2, $3, $4, $5, $6)`,
					[org.id, campaign!.id, index * couponsPerBuyer + coupon, contact!.id, order!.id, `e2e-${stamp}-${index}`]
				);
			}
		}
		// The 20 official extracts, none of them a sold coupon (0000-0011): the prize stays vacant.
		const extracts = `{${Array.from({ length: 20 }, (_, index) => 5000 + index).join(',')}}`;
		await sql.unsafe(
			`insert into app.quiniela_draws (organization_id, campaign_id, round, source, drawn_at, extracts, evidence_url, manifest_sha256)
			values ($1, $2, 1, 'Quiniela de la Ciudad, Nocturna (E2E)', now() - interval '1 day', $3::int[], 'https://loteria.example/e2e.pdf', $4)`,
			[org.id, campaign!.id, extracts, '0'.repeat(64)]
		);
		return campaign!.id;
	});
}

async function stored(id: string) {
	return withSql(async (sql) => {
		const draws = await sql.unsafe<{ picks: { role: string; rank: number; entryNumber: number }[]; candidate_count: number }>(
			`select picks, candidate_count from app.app_draws where campaign_id = $1`,
			[id]
		);
		const [awards] = await sql.unsafe<{ count: string }>(`select count(*) from app.prize_awards where campaign_id = $1`, [id]);
		return { draws, awards: Number(awards!.count) };
	});
}

async function signIn(page: Page) {
	await page.goto('/admin/login?next=/admin/campanas');
	await page.getByLabel('Email').fill('owner@tallerdemo.local');
	await page.getByLabel('Contraseña').fill(password!);
	await page.getByRole('button', { name: 'Ingresar' }).click();
	await page.waitForURL((url) => url.pathname === '/admin/campanas');
}

/** Opens a page and waits for hydration: a click before it posts the form without JavaScript. */
async function open(page: Page, path: string) {
	await page.goto(path);
	await page.waitForLoadState('networkidle');
}

/** The winner card leaves the next button fully visible below it, and the button is what a click hits. */
async function expectButtonClear(page: Page, name: RegExp | string) {
	const button = page.getByRole('button', { name });
	await expect(button).toBeVisible();
	// Measure the card at its final size, after its entrance animation.
	await page.locator('.winner').evaluate((node) => Promise.all(node.getAnimations().map((animation) => animation.finished)));
	const card = (await page.locator('.winner').boundingBox())!;
	const box = (await button.boundingBox())!;
	const viewport = page.viewportSize()!;
	expect(card.y + card.height, 'the card ends above the button').toBeLessThanOrEqual(box.y + 1);
	expect(box.y + box.height, 'the button fits the screen').toBeLessThanOrEqual(viewport.height);
	expect(box.x).toBeGreaterThanOrEqual(0);
	expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
	const hit = await page.evaluate(([x, y]) => document.elementFromPoint(x!, y!)?.closest('button')?.textContent?.trim() ?? null, [box.x + box.width / 2, box.y + box.height / 2]);
	expect(hit).toBe((await button.textContent())!.trim());
}

const pad = (value: number) => String(value).padStart(4, '0');
const maskedOf = (entryNumber: number) => buyers[Math.floor(entryNumber / couponsPerBuyer)]!.masked;
const live = (page: Page) => page.locator('#app-draw-live');

test.beforeAll(async () => {
	campaignId = await seedAwardingCampaign();
});

test.afterAll(async () => {
	if (!campaignId) return;
	await withSql((sql) => sql.unsafe(`update app.campaigns set status = 'archived' where id = $1`, [campaignId]));
});

test('the awards page offers the in-app draw of the vacant prize', async ({ page }) => {
	await signIn(page);
	await open(page, `/admin/campanas/${campaignId}/premios`);
	const offer = page.getByRole('region', { name: 'Sorteo en la app' });
	await expect(offer).toContainText('La Quiniela dejó 1 premio vacante. La plataforma lo sortea entre los 12 cupones sin premio con un número aleatorio criptográfico.');
	await offer.getByRole('link', { name: 'Sortear premios vacantes en la app' }).click();
	await expect(page).toHaveURL(new RegExp(`/admin/campanas/${campaignId}/sorteo-app$`));
	await page.waitForLoadState('networkidle');
	await expect(page.getByRole('heading', { name: 'Sorteo de los premios vacantes' })).toBeVisible();
	await expect(page.getByText('12', { exact: true })).toBeVisible();
	await expect(page.getByText(/SHA-256 de la lista: [0-9a-f]{8}…[0-9a-f]{8}/)).toBeVisible();
	// The campaign page no longer offers reopening (L14).
	await open(page, `/admin/campanas/${campaignId}`);
	await expect(page.getByRole('button', { name: /Abrir la ronda/ })).toHaveCount(0);
	await expect(page.getByRole('link', { name: 'Sortear premios vacantes en la app' })).toBeVisible();
});

test('the reel spins every coupon with masked names and stops on the stored winner, then the alternate', async ({ page }) => {
	test.setTimeout(90_000);
	await page.setViewportSize({ width: 1280, height: 720 });
	await signIn(page);
	await open(page, `/admin/campanas/${campaignId}/sorteo-app`);
	const idleSize = await page.locator('.reel-row.centre .number').first().evaluate((node) => parseFloat(getComputedStyle(node).fontSize));
	await page.getByRole('link', { name: 'Sortear', exact: true }).click();
	await expect(page.getByText('No se puede deshacer')).toBeVisible();
	await page.getByRole('button', { name: 'Confirmar y sortear' }).click();

	// While it spins: full coupon numbers and masked names only, never a full name.
	await expect(live(page)).toHaveText(new RegExp(`^Sorteando: Ganador del ${prizeTitle}\\.$`), { timeout: 10_000 });
	const row = page.locator('.reel-row').first();
	await expect(row).toHaveText(/^\d{4}\s*\S\S\*\*\* \S\.$/);
	for (const buyer of buyers) await expect(page.locator('body')).not.toContainText(buyer.firstName);
	// Readable on a 720p stream: the centre row is at least as big as before the draw, and clear of the prize title.
	const spinSize = await page.locator('.reel-row.centre .number').first().evaluate((node) => parseFloat(getComputedStyle(node).fontSize));
	expect(spinSize).toBeGreaterThanOrEqual(36);
	expect(spinSize).toBeGreaterThanOrEqual(idleSize);
	const title = (await page.locator('.prize-title').boundingBox())!;
	const windowBox = (await page.locator('.reel .window').boundingBox())!;
	expect(windowBox.y).toBeGreaterThan(title.y + title.height);

	const { draws } = await stored(campaignId);
	expect(draws, 'the draw is stored before the screen reveals it').toHaveLength(1);
	const [winner, alternate] = draws[0]!.picks;
	expect(draws[0]!.candidate_count).toBe(12);
	await expect(live(page)).toHaveText(`Ganador del ${prizeTitle}: cupón ${pad(winner!.entryNumber)}, ${maskedOf(winner!.entryNumber)}`, { timeout: 20_000 });
	await expect(page.locator('.winner-number')).toHaveText(pad(winner!.entryNumber));

	await expectButtonClear(page, `Siguiente: Suplente 1 del ${prizeTitle}`);
	await page.getByRole('button', { name: `Siguiente: Suplente 1 del ${prizeTitle}` }).click();
	await expect(live(page)).toHaveText(`Suplente 1 del ${prizeTitle}: cupón ${pad(alternate!.entryNumber)}, ${maskedOf(alternate!.entryNumber)}`, { timeout: 15_000 });
	await page.getByRole('button', { name: 'Ver todos los resultados' }).click();
	await expect(page.getByRole('heading', { name: 'Resultado del sorteo' })).toBeVisible();
});

test('a reload replays the stored draw and never draws again', async ({ page }) => {
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await signIn(page);
	const before = await stored(campaignId);
	await open(page, `/admin/campanas/${campaignId}/sorteo-app`);
	await expect(page.getByRole('link', { name: 'Sortear', exact: true })).toHaveCount(0);
	const winner = before.draws[0]!.picks[0]!;
	await expect(page.getByRole('listitem').filter({ hasText: `${pad(winner.entryNumber)} · ${maskedOf(winner.entryNumber)}` })).toContainText('Ganador');
	await page.getByRole('button', { name: 'Ver la animación' }).click();
	// Reduced motion: no spin, the result at once.
	await expect(live(page)).toHaveText(`Ganador del ${prizeTitle}: cupón ${pad(winner.entryNumber)}, ${maskedOf(winner.entryNumber)}`, { timeout: 3_000 });
	expect(await stored(campaignId)).toEqual(before);
	expect(before.awards).toBe(2);

	await open(page, `/admin/campanas/${campaignId}/premios`);
	await expect(page.getByRole('link', { name: 'Ver el sorteo en la app' })).toBeVisible();
	await expect(page.getByText('Sorteo en la app', { exact: true }).first()).toBeVisible();
});

for (const viewport of [
	{ width: 1280, height: 720 },
	{ width: 1920, height: 1080 },
	{ width: 390, height: 844 }
]) {
	test(`the winner card leaves the next button visible and clickable at ${viewport.width}x${viewport.height}`, async ({ page }) => {
		// Reduced motion lands at once; the layout of the stopped reel is the same as after a spin.
		await page.emulateMedia({ reducedMotion: 'reduce' });
		await page.setViewportSize(viewport);
		await signIn(page);
		await open(page, `/admin/campanas/${campaignId}/sorteo-app`);
		await page.getByRole('button', { name: 'Ver la animación' }).click();
		await expect(page.locator('.winner')).toBeVisible();
		const card = (await page.locator('.winner').boundingBox())!;
		const title = (await page.locator('.prize-title').boundingBox())!;
		expect(card.y, 'the card stays below the prize title').toBeGreaterThanOrEqual(title.y + title.height);
		expect(card.x).toBeGreaterThanOrEqual(0);
		expect(card.x + card.width).toBeLessThanOrEqual(viewport.width);
		// The side table of winners (owner-feedback-2026-11-12 S3) is shown beside the reel on wide screens only.
		const tally = page.getByRole('complementary', { name: 'Ganadores' });
		if (viewport.width > 860) {
			await expect(tally).toBeVisible();
			await expect(tally).toContainText('1 de 2');
			await expect(tally).toContainText('Por sortear');
			const side = (await tally.boundingBox())!;
			expect(side.x, 'the table sits right of the winner card').toBeGreaterThanOrEqual(card.x + card.width);
		} else {
			await expect(tally).toBeHidden();
		}
		await expectButtonClear(page, `Siguiente: Suplente 1 del ${prizeTitle}`);
		await page.getByRole('button', { name: `Siguiente: Suplente 1 del ${prizeTitle}` }).click();
		await expectButtonClear(page, 'Ver todos los resultados');
	});
}

// T13 (S12, L18): the public transparency page offers the candidate list as a plain-text
// download instead of listing it, and its SHA-256 is the published one.
test('transparency offers the candidate list as a .txt whose sha256sum is the published hash', async ({ page }) => {
	const [record] = await withSql((sql) => sql.unsafe<{ candidate_sha256: string }>(`select candidate_sha256 from app.app_draws where campaign_id = $1`, [campaignId]));
	await open(page, `/sorteos/e2e-sorteo-app-${stamp}/transparencia`);
	await expect(page.getByText(record!.candidate_sha256, { exact: true })).toBeVisible();
	// No inline list of every coupon: the numbers are only in the file.
	await expect(page.getByText("printf '")).toHaveCount(0);
	const file = `e2e-sorteo-app-${stamp}-cupones-sorteo-app-ronda-1.txt`;
	await page.getByText('Cómo verificarla').last().click();
	await expect(page.getByText(`sha256sum ${file}`)).toBeVisible();

	const downloading = page.waitForEvent('download');
	await page.getByRole('link', { name: 'Descargar la lista de cupones (.txt)' }).click();
	const download = await downloading;
	expect(download.suggestedFilename()).toBe(file);
	const bytes = await readFile((await download.path())!);
	// What `sha256sum <file>` prints, over the bytes as downloaded.
	expect(createHash('sha256').update(bytes).digest('hex')).toBe(record!.candidate_sha256);
	expect(bytes.toString('utf8')).toBe(Array.from({ length: buyers.length * couponsPerBuyer }, (_, index) => pad(index)).join('\n'));
});

// T13 (S12, L18): a unit nobody can win any more is declared void with a reason, and the
// public record shows it as "Desierto". Here the winner and the alternate both decline.
test('a unit whose winner and alternate declined is declared void and shown as "Desierto"', async ({ page }) => {
	await signIn(page);
	await open(page, `/admin/campanas/${campaignId}/premios`);
	const unit = page.locator('article.slot').first();
	for (let step = 0; step < 2; step++) {
		await unit.getByText('Rechazó, no reclamó o no cumple').click();
		await unit.getByLabel('Decisión').selectOption('declined');
		await unit.getByLabel('Motivo').fill('No respondió en el plazo de las bases');
		await unit.getByRole('button', { name: 'Registrar y pasar al siguiente' }).click();
		await page.waitForLoadState('networkidle');
	}
	await expect(unit.getByText('Sin suplentes disponibles')).toBeVisible();

	const reason = 'El ganador y el suplente no reclamaron el premio';
	await unit.getByText('Declarar desierto').first().click();
	await unit.getByLabel('Motivo').fill(reason);
	await unit.getByRole('button', { name: 'Declarar desierto' }).click();
	await expect(unit.getByText('Unidad declarada desierta')).toBeVisible();
	await expect(unit.locator('.chip', { hasText: 'Desierto' })).toBeVisible();
	await expect(unit.getByText(`: ${reason}`)).toBeVisible();
	await expect(unit.getByText('Declarar desierto')).toHaveCount(0);
	const [stored] = await withSql((sql) => sql.unsafe<{ reason: string }>(`select reason from app.prize_slot_voids where campaign_id = $1`, [campaignId]));
	expect(stored!.reason).toBe(reason);

	// Public with the round's results.
	await withSql((sql) =>
		sql.unsafe(
			`insert into app.draw_events (organization_id, campaign_id, kind, round, title, occurred_at)
			select organization_id, id, 'result_published', 1, 'Resultados (E2E)', now() from app.campaigns where id = $1`,
			[campaignId]
		)
	);
	await open(page, `/sorteos/e2e-sorteo-app-${stamp}/transparencia`);
	const row = page.getByRole('listitem').filter({ hasText: `${prizeTitle}, unidad 1` }).filter({ hasText: 'Desierto' });
	await expect(row).toContainText('Desierto');
	await expect(row).toContainText(reason);
});
