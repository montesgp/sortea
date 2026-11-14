import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

// odd/tasks/draw-room.md T5 (S3, S4, L1) and ADR 0024 §5: the draw host ("Conductor del sorteo")
// signs in and lands in the draw room. They type the 20 Quiniela extracts as they come out, see
// each match at once and the winners table grow, confirm the 20 together, then draw the units
// still vacant one by one in the app; broadcast mode shows no personal or system data, and any
// other panel page says "No tenés acceso".
//
// T9 (S6, S8; ADR 0026): a campaign whose prizes are `app` has no Quiniela entry; the host draws
// each prize with one tirada bound to the next drand round (the real beacon, through the local
// API), the reel stops on each winner, and the transparency page lets anyone recompute them.
//
// Seed data never reaches the awarding stage (no approvals), so this spec writes two fresh demo
// campaigns of Taller Demo straight into the database: awarding, each with its published manifest
// of 12 coupons from 4 buyers, and a draw host member whose password is the seed's. The draws are
// append-only, so the campaigns are archived afterwards and the member disabled.
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
const timezone = 'America/Argentina/Buenos_Aires';
const motoTitle = `Moto E2E ${stamp}`;
const cashTitle = `Efectivo E2E ${stamp}`;
const appMotoTitle = `Moto drand E2E ${stamp}`;
const appCashTitle = `Efectivo drand E2E ${stamp}`;
const hostEmail = `e2e-conductor-${stamp}@tallerdemo.local`;
const buyers = [
	{ firstName: 'Juana', lastName: 'Pérez', masked: 'Ju*** P.' },
	{ firstName: 'Martín', lastName: 'Gómez', masked: 'Ma*** G.' },
	{ firstName: 'Lucía', lastName: 'Ñáñez', masked: 'Lu*** Ñ.' },
	{ firstName: 'Pedro', lastName: 'Ruiz', masked: 'Pe*** R.' }
];
const couponsPerBuyer = 3;
// The 2nd extract is coupon 0003 (Martín); every other one is a number nobody holds.
const extracts = ['5000', '0003', ...Array.from({ length: 18 }, (_, index) => String(5001 + index))];
let campaignId = '';
let appCampaignId = '';
let hostId = '';
const appSlug = `e2e-drand-${stamp}`;

async function withSql<T>(run: (sql: ReturnType<typeof postgres>) => Promise<T>): Promise<T> {
	const sql = postgres(databaseUrl, { max: 1 });
	try {
		return await run(sql);
	} finally {
		await sql.end();
	}
}

/**
 * Awarding, from the last prize to the first: the cash prize (3 units) comes first, the moto (1
 * unit) last, no alternates. With Quiniela prizes, one match gives cash unit 1; cash units 2 and 3
 * and the moto stay vacant for the app.
 */
async function seedRoom(input: { slug: string; title: string; mechanism: 'quiniela' | 'app'; moto: string; cash: string }) {
	return withSql(async (sql) => {
		const [org] = await sql.unsafe<{ id: string }>(`select id from app.organizations where slug = 'taller-demo'`);
		if (!org) throw new Error('Taller Demo is not seeded');
		const [campaign] = await sql.unsafe<{ id: string }>(
			`insert into app.campaigns (organization_id, slug, title, summary, status, timezone, opens_at, closes_at, is_demo, next_entry_number, award_order)
			values ($1, $2, $3, 'Campaña de prueba automática de la sala de sorteo.', 'awarding', $4, now() - interval '20 days', now() - interval '2 days', true, $5, 'last_to_first')
			returning id`,
			[org.id, input.slug, input.title, timezone, buyers.length * couponsPerBuyer]
		);
		const id = campaign!.id;
		await sql.unsafe(
			`insert into app.prizes (organization_id, campaign_id, position, kind, title, declared_value_minor, quantity, alternates_count, mechanism)
			values ($1, $2, 1, 'vehicle', $3, 100000000, 1, 0, $5), ($1, $2, 2, 'cash', $4, 10000000, 3, 0, $5)`,
			[org.id, id, input.moto, input.cash, input.mechanism]
		);
		const entries: { entryNumber: number; holder: string; status: 'eligible' }[] = [];
		for (const [index, buyer] of buyers.entries()) {
			const email = `${input.slug}-${index}@example.com`;
			const [contact] = await sql.unsafe<{ id: string }>(`insert into app.contacts (organization_id, first_name, last_name, email) values ($1, $2, $3, $4) returning id`, [
				org.id,
				buyer.firstName,
				buyer.lastName,
				email
			]);
			const buyerJson = { firstName: buyer.firstName, lastName: buyer.lastName, email, phone: null };
			const pricing = { lines: [], subtotalMinor: 1000, deliveryFeeMinor: 0, totalMinor: 1000, currency: 'ARS', pricedAt: new Date().toISOString() };
			const [order] = await sql.unsafe<{ id: string }>(
				`insert into app.orders (organization_id, reference, access_code_hash, contact_id, buyer, campaign_id, status, currency, subtotal_minor, delivery_fee_minor, total_minor, delivery_method, pricing_snapshot, payment_provider, paid_at, expires_at)
				values ($1, $2, 'e2e', $3, $4::jsonb, $5, 'paid', 'ARS', 1000, 0, 1000, 'digital', $6::jsonb, 'simulator', now() - interval '3 days', now() - interval '3 days')
				returning id`,
				[org.id, `${input.slug}-${index}`.toUpperCase(), contact!.id, JSON.stringify(buyerJson), id, JSON.stringify(pricing)]
			);
			for (let coupon = 0; coupon < couponsPerBuyer; coupon++) {
				const entryNumber = index * couponsPerBuyer + coupon;
				const holder = `${input.slug}-${index}`;
				await sql.unsafe(`insert into app.participation_entries (organization_id, campaign_id, entry_number, contact_id, order_id, holder_pseudonym) values ($1, $2, $3, $4, $5, $6)`, [
					org.id,
					id,
					entryNumber,
					contact!.id,
					order!.id,
					holder
				]);
				entries.push({ entryNumber, holder, status: 'eligible' });
			}
		}
		// The published manifest the Quiniela is matched against (sortea.manifest.v2, as `serializeManifest` writes it).
		const closedAt = new Date(Date.now() - 2 * 86_400_000).toISOString();
		const header = { format: 'sortea.manifest.v2', campaignId: id, round: 1, ruleVersion: 1, entryDigits: 4, closedAt, eligibleCount: entries.length, voidCount: 0 };
		const content = [JSON.stringify(header), ...entries.map((entry) => JSON.stringify(entry))].join('\n') + '\n';
		await sql.unsafe(
			`insert into app.draw_manifests (organization_id, campaign_id, round, rule_version, sha256, content, eligible_count, void_count, closed_at, published_at)
			values ($1, $2, 1, 1, $3, $4, $5, 0, $6, $6)`,
			[org.id, id, createHash('sha256').update(content).digest('hex'), content, entries.length, closedAt]
		);
		return id;
	});
}

/** The draw host, with the seed's password (copied from the seeded owner) and no other role. */
async function seedHost() {
	return withSql(async (sql) => {
		const [org] = await sql.unsafe<{ id: string }>(`select id from app.organizations where slug = 'taller-demo'`);
		const [user] = await sql.unsafe<{ id: string }>(
			`insert into app.admin_users (email, password_hash, must_change_password) select $1, password_hash, false from app.admin_users where lower(email) = 'owner@tallerdemo.local' returning id`,
			[hostEmail]
		);
		await sql.unsafe(`insert into app.organization_members (organization_id, user_id, email, role) values ($1, $2, $3, 'draw_host')`, [org!.id, user!.id, hostEmail]);
		return user!.id;
	});
}

/** The round's results go public (what "Publicar resultados" records), so tirada lists and hashes are shown. */
async function publishResults(id: string) {
	await withSql((sql) =>
		sql.unsafe(
			`insert into app.draw_events (organization_id, campaign_id, kind, round, title, occurred_at) select organization_id, id, 'result_published', 1, 'Resultados publicados', now() from app.campaigns where id = $1`,
			[id]
		)
	);
}

/** The drand-backed tiradas of the app prizes with their reveal, in order. */
async function prizeDraws(id: string) {
	return withSql((sql) =>
		sql.unsafe<{
			sequence: number;
			title: string;
			slots: number[];
			drand_round: number;
			candidate_count: number;
			candidate_sha256: string;
			randomness: string | null;
			picks: { slot: number; entryNumber: number }[] | null;
		}>(
			`select d.sequence, p.title, d.slots, d.drand_round, d.candidate_count, d.candidate_sha256, r.randomness, r.picks
			from app.app_prize_draws d join app.prizes p on p.id = d.prize_id left join app.app_prize_draw_reveals r on r.draw_id = d.id
			where d.campaign_id = $1 order by d.sequence`,
			[id]
		)
	);
}

async function tiradas(id: string) {
	return withSql((sql) =>
		sql.unsafe<{ sequence: number; slot: number; title: string; entry_number: number; candidate_count: number; candidate_sha256: string }>(
			`select t.sequence, t.slot, p.title, t.entry_number, t.candidate_count, t.candidate_sha256 from app.app_unit_draws t join app.prizes p on p.id = t.prize_id where t.campaign_id = $1 order by t.sequence`,
			[id]
		)
	);
}

async function signInAsHost(page: Page) {
	await page.goto('/admin/login');
	await page.getByLabel('Email').fill(hostEmail);
	await page.getByLabel('Contraseña').fill(password!);
	await page.getByRole('button', { name: 'Ingresar' }).click();
	await page.waitForURL((url) => url.pathname === '/admin/sala-de-sorteo');
}

/** Opens a page and waits for hydration: typing before it reaches inputs without their handlers. */
async function open(page: Page, path: string) {
	await page.goto(path);
	await page.waitForLoadState('networkidle');
}

const pad = (value: number) => String(value).padStart(4, '0');
const maskedOf = (entryNumber: number) => buyers[Math.floor(entryNumber / couponsPerBuyer)]!.masked;
const unitRow = (page: Page, label: string) => page.getByRole('listitem', { name: new RegExp(`posición: ${label.replace(/[$.]/g, '\\$&')}$`) });

/** Now minus an hour, as dd/mm/aaaa and hh:mm in the campaign time zone: after the manifest and not in the future. */
function officialTime() {
	const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(
		new Date(Date.now() - 3_600_000)
	);
	const part = (type: string) => parts.find((candidate) => candidate.type === type)!.value;
	return { date: `${part('day')}/${part('month')}/${part('year')}`, time: `${part('hour')}:${part('minute')}` };
}

test.beforeAll(async () => {
	campaignId = await seedRoom({ slug: `e2e-sala-${stamp}`, title: `Sala de sorteo E2E ${stamp}`, mechanism: 'quiniela', moto: motoTitle, cash: cashTitle });
	appCampaignId = await seedRoom({ slug: appSlug, title: `Sorteo drand E2E ${stamp}`, mechanism: 'app', moto: appMotoTitle, cash: appCashTitle });
	hostId = await seedHost();
});

test.afterAll(async () => {
	await withSql(async (sql) => {
		for (const id of [campaignId, appCampaignId]) if (id) await sql.unsafe(`update app.campaigns set status = 'archived' where id = $1`, [id]);
		if (hostId) await sql.unsafe(`update app.organization_members set status = 'disabled' where user_id = $1`, [hostId]);
	});
});

test('the draw host lands in the room, types the 20 extracts with live matches, and confirms them', async ({ page }) => {
	test.setTimeout(120_000);
	await signInAsHost(page);
	// No sections to manage: only the room, the account and sign out.
	await expect(page.getByRole('heading', { name: 'Sala de sorteo' })).toBeVisible();
	for (const section of ['Pedidos', 'Campañas', 'Productos', 'Configuración', 'Resumen']) await expect(page.getByRole('link', { name: section, exact: true })).toHaveCount(0);
	await expect(page.getByRole('link', { name: 'Mi cuenta' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Salir' })).toBeVisible();

	await page.getByRole('link', { name: new RegExp(`Sala de sorteo E2E ${stamp}`) }).click();
	await page.waitForURL(new RegExp(`/admin/sala-de-sorteo/${campaignId}$`));
	await page.waitForLoadState('networkidle');
	await expect(page.getByText('Se adjudica del último premio al primero')).toBeVisible();
	await expect(page.getByText('Cupones habilitados')).toBeVisible();
	await expect(unitRow(page, `${cashTitle}, unidad 1`)).toContainText('Por definir');

	// 1.º: no coupon. 2.º: coupon 0003, which takes the first unit in award order at once.
	await page.locator('#extract-1').click();
	await page.keyboard.type(extracts[0]!);
	await expect(page.locator('#extract-2')).toBeFocused();
	await expect(page.locator('#extract-1-outcome')).toHaveText('Sin coincidencia');
	await page.keyboard.type(extracts[1]!);
	await expect(page.locator('#extract-2-outcome')).toHaveText(`Ganador: ${cashTitle}, unidad 1`);
	await expect(unitRow(page, `${cashTitle}, unidad 1`)).toContainText(`0003`);
	await expect(unitRow(page, `${cashTitle}, unidad 1`)).toContainText(maskedOf(3));
	// A wrong 3rd number is corrected: Backspace back into it, then the right one.
	await page.keyboard.type('0004');
	await expect(page.locator('#extract-3-outcome')).toHaveText(`Ganador: ${cashTitle}, unidad 2`);
	await page.keyboard.press('Backspace');
	await expect(page.locator('#extract-3')).toBeFocused();
	await page.locator('#extract-3').fill('');
	await page.keyboard.type(extracts[2]!);
	await expect(page.locator('#extract-3-outcome')).toHaveText('Sin coincidencia');
	await expect(unitRow(page, `${cashTitle}, unidad 2`)).toContainText('Por definir');
	for (const value of extracts.slice(3, 10)) await page.keyboard.type(value);

	// The page is lost: the draft brings the numbers back.
	await open(page, `/admin/sala-de-sorteo/${campaignId}`);
	await expect(page.locator('#extract-10')).toHaveValue(extracts[9]!);
	await expect(unitRow(page, `${cashTitle}, unidad 1`)).toContainText('0003');
	await page.locator('#extract-11').click();
	for (const value of extracts.slice(10)) await page.keyboard.type(value);
	await expect(page.locator('#extract-20')).toHaveValue(extracts[19]!);

	const official = officialTime();
	await page.locator('#drawDate').fill(official.date);
	await page.locator('#drawDate-time').fill(official.time);
	await page.getByLabel('Enlace al extracto oficial').fill('https://loteria.example/e2e-extracto.pdf');
	await page.getByRole('button', { name: 'Confirmar los 20 números' }).click();
	const confirm = page.getByRole('alertdialog', { name: '¿Registrás los 20 números?' });
	await expect(confirm).toContainText('1 premio queda con ganador y 3 quedan vacantes');
	await confirm.getByRole('button', { name: 'Registrar los 20 números' }).click();

	// Recorded: the positions are read only and the vacant units can be drawn.
	await expect(page.locator('#extract-1')).toHaveCount(0);
	await expect(unitRow(page, `${cashTitle}, unidad 1`)).toContainText('0003');
	await expect(unitRow(page, `${cashTitle}, unidad 1`)).toContainText('Quiniela');
	await expect(unitRow(page, motoTitle)).toContainText('Vacante');
	await expect(page.getByRole('button', { name: 'Sortear esta posición' })).toHaveCount(3);
	expect(await page.evaluate((key) => localStorage.getItem(key), `sortea:sala-de-sorteo:${campaignId}:ronda-1`)).toBeNull();
});

test('the host draws a vacant unit: the reel stops on the stored pick, the table fills in and the tirada is logged', async ({ page }) => {
	test.setTimeout(90_000);
	await signInAsHost(page);
	await open(page, `/admin/sala-de-sorteo/${campaignId}`);
	await unitRow(page, `${cashTitle}, unidad 2`).getByRole('button', { name: 'Sortear esta posición' }).click();
	const stage = page.getByRole('dialog', { name: `${cashTitle}, unidad 2` });
	await expect(stage).toContainText('Participan 11 cupones sin premio');
	await stage.getByRole('button', { name: 'Confirmar y sortear' }).click();

	// While it spins (the API answered, so the tirada is stored): coupon numbers and masked names only, never a full name.
	await expect(stage).toContainText('Pasan los 11 cupones en juego.', { timeout: 10_000 });
	await expect(stage.locator('.reel-row').first()).toHaveText(/^\d{4}\s*\S\S\*\*\* \S\.$/);
	for (const buyer of buyers) await expect(page.locator('body')).not.toContainText(buyer.firstName);
	const [stored] = await tiradas(campaignId);
	expect(stored, 'the tirada is stored before the screen reveals it').toMatchObject({ sequence: 1, slot: 2, title: cashTitle, candidate_count: 11 });
	await expect(stage.locator('.winner-number')).toHaveText(pad(stored!.entry_number), { timeout: 20_000 });
	await expect(stage.locator('.winner-name')).toHaveText(maskedOf(stored!.entry_number));
	await stage.getByRole('button', { name: 'Volver a la tabla' }).click();

	await expect(unitRow(page, `${cashTitle}, unidad 2`)).toContainText(pad(stored!.entry_number));
	await expect(unitRow(page, `${cashTitle}, unidad 2`)).toContainText('Sorteo en la app');
	const log = page.getByRole('region', { name: 'Registro de tiradas' });
	await expect(log).toContainText(`Tirada 1: ${cashTitle}, unidad 2`);
	await expect(log).toContainText(`Entre 11 cupones · SHA-256 ${stored!.candidate_sha256.slice(0, 8)}…${stored!.candidate_sha256.slice(-8)}`);
	// A reload shows the same state from the API, and the drawn unit is not offered again.
	await open(page, `/admin/sala-de-sorteo/${campaignId}`);
	await expect(unitRow(page, `${cashTitle}, unidad 2`)).toContainText(pad(stored!.entry_number));
	await expect(unitRow(page, `${cashTitle}, unidad 2`).getByRole('button', { name: 'Sortear esta posición' })).toHaveCount(0);
	expect(await tiradas(campaignId)).toHaveLength(1);

	// The coupon lookup says it won, with the name the holder allows (masked: no consent here).
	await page.getByLabel('Número de cupón').fill(pad(stored!.entry_number));
	await expect(page.getByRole('article', { name: `Resultado del cupón N.º ${pad(stored!.entry_number)}` })).toContainText('Cupón ganador');
});

for (const [index, viewport] of [
	{ width: 1280, height: 720 },
	{ width: 390, height: 844 }
].entries()) {
	test(`broadcast mode at ${viewport.width}x${viewport.height} shows no personal or system data and keeps the draw button and the winner card visible`, async ({ page }) => {
		test.setTimeout(90_000);
		// Reduced motion lands at once; the stopped reel and its card are the same as after a spin.
		await page.emulateMedia({ reducedMotion: 'reduce' });
		await page.setViewportSize(viewport);
		await signInAsHost(page);
		await open(page, `/admin/sala-de-sorteo/${campaignId}?transmision`);
		const body = page.locator('body');
		await expect(page.getByRole('heading', { name: `Sala de sorteo E2E ${stamp}` })).toBeVisible();
		for (const hidden of [hostEmail, 'Mi cuenta', 'Taller Demo', 'https://', 'Copiar', 'Enlace al extracto oficial']) await expect(body).not.toContainText(hidden);
		await expect(page.getByRole('button', { name: 'Salir', exact: true })).toHaveCount(0);
		const [first] = await tiradas(campaignId);
		await expect(body).not.toContainText(first!.candidate_sha256);

		// Units left to draw: cash unit 3 at 1280x720, then the moto at 390x844.
		const label = index === 0 ? `${cashTitle}, unidad 3` : motoTitle;
		const draw = unitRow(page, label).getByRole('button', { name: 'Sortear esta posición' });
		await draw.scrollIntoViewIfNeeded();
		await expect(draw).toBeVisible();
		await expect(draw).toBeInViewport();
		await draw.click();
		const stage = page.getByRole('dialog', { name: label });
		await stage.getByRole('button', { name: 'Confirmar y sortear' }).click();
		const card = stage.locator('.winner');
		await expect(card).toBeVisible({ timeout: 10_000 });
		await card.evaluate((node) => Promise.all(node.getAnimations().map((animation) => animation.finished)));
		const box = (await card.boundingBox())!;
		expect(box.x).toBeGreaterThanOrEqual(0);
		expect(box.y).toBeGreaterThanOrEqual(0);
		expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
		expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
		const back = stage.getByRole('button', { name: 'Volver a la tabla' });
		await expect(back).toBeInViewport();
		for (const hidden of [hostEmail, 'https://']) await expect(body).not.toContainText(hidden);
		await back.click();
		await expect(unitRow(page, label)).toContainText('Sorteo en la app');
	});
}

test('a draw host opening any other panel page sees "No tenés acceso" with the way back to the room', async ({ page }) => {
	await signInAsHost(page);
	for (const path of ['/admin/pedidos', `/admin/campanas/${campaignId}`]) {
		const response = await page.goto(path);
		expect(response?.status(), path).toBe(403);
		await expect(page.getByRole('heading', { name: 'No tenés acceso' })).toBeVisible();
	}
	await page.getByRole('link', { name: 'Volver a la sala de sorteo' }).click();
	await page.waitForURL((url) => url.pathname === '/admin/sala-de-sorteo');
	// /admin is the room too.
	await page.goto('/admin');
	await page.waitForURL((url) => url.pathname === '/admin/sala-de-sorteo');
});

// ADR 0024 §6 as amended: each tirada is public at once (time, unit, count); its coupon, SHA-256
// and candidate list (a plain-text download whose sha256sum is the published hash) go public with
// the round's results (8411d64).
test('transparency lists each tirada with a .txt candidate list whose sha256sum is the published hash', async ({ page }) => {
	const [first] = await tiradas(campaignId);
	await open(page, `/sorteos/e2e-sala-${stamp}/transparencia`);
	const section = page.getByRole('region', { name: 'Tiradas del sorteo en la app' });
	await expect(section).toContainText(`Tirada 1: ${cashTitle}, unidad 2.`);
	await expect(section).toContainText('El cupón sorteado, la lista de cupones y su huella se publican con los resultados de la ronda.');
	await expect(section).not.toContainText(first!.candidate_sha256);
	await publishResults(campaignId);
	await open(page, `/sorteos/e2e-sala-${stamp}/transparencia`);
	await expect(section).toContainText(first!.candidate_sha256);
	await expect(section).toContainText(`Cupón sorteado: ${pad(first!.entry_number)}`);
	const file = `e2e-sala-${stamp}-cupones-sorteo-app-ronda-1-tirada-1.txt`;
	const downloading = page.waitForEvent('download');
	await section.getByRole('link', { name: 'Descargar la lista de cupones de la tirada 1 (.txt)' }).click();
	const download = await downloading;
	expect(download.suggestedFilename()).toBe(file);
	const bytes = await readFile((await download.path())!);
	expect(createHash('sha256').update(bytes).digest('hex')).toBe(first!.candidate_sha256);
	// Every coupon but the Quiniela's winner (0003), one per line, no final newline.
	expect(bytes.toString('utf8')).toBe(
		Array.from({ length: buyers.length * couponsPerBuyer }, (_, entryNumber) => entryNumber)
			.filter((entryNumber) => entryNumber !== 3)
			.map(pad)
			.join('\n')
	);
});

// ─── App prizes: one drand-backed tirada per prize (T9; S6, S8; ADR 0026) ──────────────────────

const prizeRow = (page: Page, title: string) => page.getByRole('listitem', { name: `Premio: ${title}` });

test('the host draws a 3-unit app prize with one tirada on the next drand round: three stops, three winners and the tirada record', async ({ page }) => {
	test.setTimeout(150_000);
	await signInAsHost(page);
	await open(page, `/admin/sala-de-sorteo/${appCampaignId}`);
	// No Quiniela prizes: no Quiniela entry and no per-unit table.
	await expect(page.getByRole('heading', { name: 'Números de la Quiniela' })).toHaveCount(0);
	await expect(page.locator('#extract-1')).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Sortear esta posición' })).toHaveCount(0);
	// Award order last to first: the cash prize is listed first and is the highlighted action.
	await expect(page.getByRole('listitem', { name: /^Premio: / })).toHaveText([new RegExp(appCashTitle), new RegExp(appMotoTitle)]);
	await expect(prizeRow(page, appCashTitle)).toContainText('Pendiente');
	await expect(prizeRow(page, appCashTitle).getByRole('button', { name: `Sortear ${appCashTitle}` })).toHaveClass(/primary/);
	await expect(prizeRow(page, appMotoTitle).getByRole('button', { name: `Sortear ${appMotoTitle}` })).not.toHaveClass(/primary/);

	await prizeRow(page, appCashTitle).getByRole('button', { name: `Sortear ${appCashTitle}` }).click();
	const stage = page.getByRole('dialog', { name: appCashTitle });
	await expect(stage).toContainText(`Se sortean 3 ganadores de «${appCashTitle}» entre 12 cupones sin premio.`);
	await stage.getByRole('button', { name: 'Confirmar y sortear' }).click();
	// The click commits the next drand round, which does not exist yet: the screen waits for it.
	await expect(stage.getByRole('status')).toContainText('Esperando el número público de drand');
	await expect.poll(async () => (await prizeDraws(appCampaignId)).length).toBe(1);
	const [committed] = await prizeDraws(appCampaignId);
	expect(committed, 'the commitment is stored before the round is read').toMatchObject({ sequence: 1, title: appCashTitle, slots: [1, 2, 3], candidate_count: 12 });

	// Three stops, one per unit, coupon numbers and masked names only.
	await expect(stage).toContainText('Ganador 1 de 3', { timeout: 30_000 });
	await expect(stage.locator('.reel-row').first()).toHaveText(/^\d{4}\s*\S\S\*\*\* \S\.$/);
	for (const buyer of buyers) await expect(page.locator('body')).not.toContainText(buyer.firstName);
	const back = stage.getByRole('button', { name: 'Volver a la lista' });
	await expect(back).toBeVisible({ timeout: 60_000 });
	const [revealed] = await prizeDraws(appCampaignId);
	expect(revealed!.randomness).toMatch(/^[0-9a-f]{64}$/);
	const coupons = revealed!.picks!.map((pick) => pad(pick.entryNumber));
	expect(new Set(coupons).size).toBe(3);
	await expect(stage.getByRole('list', { name: `Ganadores de ${appCashTitle}` }).getByRole('listitem')).toHaveCount(3);
	await expect(stage).toContainText(`Ronda ${revealed!.drand_round} de drand`);
	await back.click();

	await expect(prizeRow(page, appCashTitle)).toContainText('Sorteado');
	for (const coupon of coupons) await expect(prizeRow(page, appCashTitle)).toContainText(coupon);
	await expect(prizeRow(page, appCashTitle).getByRole('button')).toHaveCount(0);
	const log = page.getByRole('region', { name: 'Registro de tiradas' });
	await expect(log).toContainText(`Tirada 1: ${appCashTitle} · 3 unidades`);
	await expect(log).toContainText(`Ronda ${revealed!.drand_round} de drand`);
	await expect(log).toContainText(`Entre 12 cupones · SHA-256 ${revealed!.candidate_sha256.slice(0, 8)}…${revealed!.candidate_sha256.slice(-8)}`);
	// The moto is now the next prize.
	await expect(prizeRow(page, appMotoTitle).getByRole('button', { name: `Sortear ${appMotoTitle}` })).toHaveClass(/primary/);

	// A reload shows the same state from the API.
	await open(page, `/admin/sala-de-sorteo/${appCampaignId}`);
	for (const coupon of coupons) await expect(prizeRow(page, appCashTitle)).toContainText(coupon);
	await expect(log).toContainText(`Tirada 1: ${appCashTitle} · 3 unidades`);
	expect(await prizeDraws(appCampaignId)).toHaveLength(1);
});

test('broadcast mode at 1280x720 keeps the prize list, the button, the drand wait and the reel on screen with no system data', async ({ page }) => {
	test.setTimeout(150_000);
	const viewport = { width: 1280, height: 720 };
	await page.setViewportSize(viewport);
	await signInAsHost(page);
	await open(page, `/admin/sala-de-sorteo/${appCampaignId}?transmision`);
	const body = page.locator('body');
	const [first] = await prizeDraws(appCampaignId);
	for (const hidden of [hostEmail, 'Mi cuenta', 'Taller Demo', 'https://', 'Copiar', first!.candidate_sha256, first!.randomness!]) await expect(body).not.toContainText(hidden);
	await expect(prizeRow(page, appCashTitle)).toBeInViewport();
	const draw = prizeRow(page, appMotoTitle).getByRole('button', { name: `Sortear ${appMotoTitle}` });
	await expect(draw).toBeInViewport();
	await draw.click();
	const stage = page.getByRole('dialog', { name: appMotoTitle });
	await expect(stage).toContainText(`Se sortea 1 ganador de «${appMotoTitle}» entre 9 cupones sin premio.`);
	await expect(stage.getByRole('button', { name: 'Confirmar y sortear' })).toBeInViewport();
	await stage.getByRole('button', { name: 'Confirmar y sortear' }).click();
	await expect(stage.getByRole('status')).toContainText('Esperando el número público de drand');
	await expect(stage.getByRole('status')).toBeInViewport();
	// The reel spins on air, inside the frame.
	await expect(stage.locator('.reel-row').first()).toBeVisible({ timeout: 30_000 });
	const reelBox = (await stage.locator('.reel').boundingBox())!;
	expect(reelBox.y).toBeGreaterThanOrEqual(0);
	expect(reelBox.y + reelBox.height).toBeLessThanOrEqual(viewport.height);
	const card = stage.locator('.winner');
	await expect(card).toBeVisible({ timeout: 30_000 });
	await card.evaluate((node) => Promise.all(node.getAnimations().map((animation) => animation.finished)));
	const box = (await card.boundingBox())!;
	expect(box.x).toBeGreaterThanOrEqual(0);
	expect(box.y).toBeGreaterThanOrEqual(0);
	expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
	expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
	const back = stage.getByRole('button', { name: 'Volver a la lista' });
	await expect(back).toBeInViewport();
	const draws = await prizeDraws(appCampaignId);
	for (const hidden of [hostEmail, 'https://', draws[1]!.candidate_sha256, draws[1]!.randomness!]) await expect(body).not.toContainText(hidden);
	await back.click();

	// Two tiradas, four distinct winners; a reload keeps them.
	expect(draws.map((row) => row.slots.length)).toEqual([3, 1]);
	const winners = draws.flatMap((row) => row.picks!.map((pick) => pad(pick.entryNumber)));
	expect(new Set(winners).size).toBe(4);
	await open(page, `/admin/sala-de-sorteo/${appCampaignId}?transmision`);
	await expect(prizeRow(page, appMotoTitle)).toContainText('Sorteado');
	await expect(prizeRow(page, appMotoTitle)).toContainText(winners[3]!);
	for (const coupon of winners.slice(0, 3)) await expect(prizeRow(page, appCashTitle)).toContainText(coupon);
	const log = page.getByRole('region', { name: 'Registro de tiradas' });
	await expect(log).toContainText(`Tirada 2: ${appMotoTitle} · 1 unidad`);
	await expect(log).toContainText(`Ronda ${draws[1]!.drand_round} de drand`);
	await expect(page.getByRole('button', { name: /^Sortear / })).toHaveCount(0);
});

test('transparency publishes each drand tirada at once, then its winners, list, hash and round, and the script recomputes the winners', async ({ page }) => {
	const draws = await prizeDraws(appCampaignId);
	await open(page, `/sorteos/${appSlug}/transparencia`);
	const section = page.getByRole('region', { name: 'Sorteo en la app con número público (drand)' });
	await expect(section).toContainText(`Tirada 1: ${appCashTitle}, 3 unidades. Comprometida el`);
	await expect(section).toContainText(`con la ronda ${draws[0]!.drand_round} de drand, entre 12 cupones sin premio.`);
	await expect(section).not.toContainText(draws[0]!.candidate_sha256);
	await publishResults(appCampaignId);
	await open(page, `/sorteos/${appSlug}/transparencia`);
	await expect(section).toContainText(draws[0]!.candidate_sha256);
	await expect(section).toContainText(draws[0]!.randomness!);
	await expect(section.getByRole('link', { name: `Ver la ronda ${draws[0]!.drand_round} en drand` })).toHaveAttribute('href', new RegExp(`/public/${draws[0]!.drand_round}$`));
	const file = `${appSlug}-cupones-sorteo-app-ronda-1-premio-1.txt`;
	await expect(section).toContainText(`node scripts/verify-app-draw.mjs --candidates ${file} --count 3 --round ${draws[0]!.drand_round}`);
	for (const pick of draws[0]!.picks!) await expect(section).toContainText(`Unidad ${pick.slot}: cupón ${pad(pick.entryNumber)}`);
	const downloading = page.waitForEvent('download');
	await section.getByRole('link', { name: 'Descargar la lista de cupones de la tirada 1 (.txt)' }).click();
	const download = await downloading;
	expect(download.suggestedFilename()).toBe(file);
	const path = (await download.path())!;
	expect(createHash('sha256').update(await readFile(path)).digest('hex')).toBe(draws[0]!.candidate_sha256);
	// The published script, with the published randomness, gives the same winners in the same order.
	const script = fileURLToPath(new URL('../../../scripts/verify-app-draw.mjs', import.meta.url));
	const output = execFileSync(process.execPath, [script, '--candidates', path, '--count', '3', '--randomness', draws[0]!.randomness!], { encoding: 'utf8' });
	expect(output.trim().split('\n').slice(2)).toEqual(draws[0]!.picks!.map((pick, index) => `${index + 1}. ${pad(pick.entryNumber)}`));
});
