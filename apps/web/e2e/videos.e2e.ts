import { expect, test, type Page } from '@playwright/test';

// S9: videos of what is raffled. The owner uploads a clip to the site library,
// attaches it to the campaign and to a prize, and the public campaign page and
// the campaign block on the home and the shop play it; a YouTube link works
// the same way through the privacy-enhanced embed.

const password = process.env.E2E_ADMIN_PASSWORD;
test.skip(!password, 'Set E2E_ADMIN_PASSWORD to the password printed by the seed');
test.describe.configure({ mode: 'serial' });

const ascii = (text: string) => Buffer.from(text, 'latin1');
/** A tiny WebM header (EBML, DocType "webm"); trailing bytes make each run a different file. */
const webm = (marker: string) =>
	Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0x82, 0x84]), ascii('webm'), Buffer.from([0x42, 0x87, 0x81, 0x04]), ascii(marker)]);
/** A tiny MP4 header (`ftyp` box). */
const mp4 = (marker: string) => Buffer.concat([Buffer.from([0, 0, 0, 0x18]), ascii('ftypisom'), Buffer.from([0, 0, 2, 0]), ascii('isommp41'), ascii(marker)]);
const youtube = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
/** Names of the files these tests add to the library; unused ones are deleted at the end, also leftovers of failed runs. */
const testFile = /^(?:moto|premio|largo)-\d+\.(?:webm|mp4)$/;

async function signIn(page: Page) {
	await page.goto('/admin/login');
	await page.getByLabel('Email').fill('owner@motogarage.local');
	await page.getByLabel('Contraseña').fill(password!);
	await page.getByRole('button', { name: 'Ingresar' }).click();
	await expect(page.getByRole('heading', { name: 'Resumen' })).toBeVisible();
}

async function uploadVideo(page: Page, name: string, buffer: Buffer, mimeType: string) {
	await page.goto('/admin/sitio?tab=imagenes');
	await page.getByLabel('Video', { exact: true }).setInputFiles({ name, mimeType, buffer });
	await page.getByRole('button', { name: 'Subir video' }).click();
	await expect(page.getByRole('status')).toContainText(`Video subido: ${name}`);
}

/** The seeded campaign editor; returns the public slug. */
async function openCampaign(page: Page): Promise<string> {
	await page.goto('/admin/campanas');
	await page.getByRole('main').getByRole('link', { name: /Tornado/ }).first().click();
	await expect(page.getByRole('heading', { name: 'Contenido y fechas' })).toBeVisible();
	const href = (await page.getByRole('link', { name: /^\/sorteos\// }).getAttribute('href'))!;
	return href.replace('/sorteos/', '');
}

async function saveCampaignVideo(page: Page, choice: { media?: string; url?: string }) {
	const details = page.locator('section', { has: page.getByRole('heading', { name: 'Contenido y fechas' }) });
	await details.getByLabel('Video de la biblioteca').selectOption(choice.media ? { label: choice.media } : { label: 'Sin video' });
	await details.getByLabel('Enlace de YouTube').fill(choice.url ?? '');
	await details.getByRole('button', { name: 'Guardar contenido' }).click();
	await expect(page.getByRole('status')).toContainText('Cambios guardados');
}

test('an uploaded video plays on the campaign page, the home and the shop', async ({ page }) => {
	const name = `moto-${Date.now()}.webm`;
	await signIn(page);
	await uploadVideo(page, name, webm(name), 'video/webm');
	const library = page.getByRole('list', { name: 'Biblioteca' });
	await expect(library.getByRole('listitem').filter({ hasText: name }).locator('video')).toHaveCount(1);

	// A fake video is refused whatever its name says.
	await page.getByLabel('Video', { exact: true }).setInputFiles({ name: 'falso.mp4', mimeType: 'video/mp4', buffer: ascii('<html>no soy un video</html>') });
	await page.getByRole('button', { name: 'Subir video' }).click();
	await expect(page.getByRole('alert')).toContainText('video MP4 o WebM');

	const slug = await openCampaign(page);
	await saveCampaignVideo(page, { media: name });

	const visitor = await page.context().newPage();
	for (const path of [`/sorteos/${slug}`, '/', '/tienda']) {
		await visitor.goto(path);
		const video = visitor.locator('main video').first();
		await expect(video, path).toBeVisible();
		await expect(video).toHaveAttribute('controls', '');
		await expect(video).toHaveAttribute('preload', 'metadata');
		await expect(video).toHaveAttribute('playsinline', '');
		await expect(video.locator('source')).toHaveAttribute('type', 'video/webm');
		expect(await video.locator('source').getAttribute('src')).toMatch(/\/storage\/v1\/object\/public\/.+\.webm$/);
	}

	// The library protects the video while the campaign uses it.
	await page.goto('/admin/sitio?tab=imagenes');
	await expect(library.getByRole('listitem').filter({ hasText: name }).getByText('En uso')).toBeVisible();
	await visitor.close();
});

test('a prize shows its own video and a YouTube link plays through the privacy-enhanced embed', async ({ page }) => {
	const name = `premio-${Date.now()}.mp4`;
	await signIn(page);
	await uploadVideo(page, name, mp4(name), 'video/mp4');
	const slug = await openCampaign(page);

	const prizes = page.locator('section', { has: page.getByRole('heading', { name: 'Premios', exact: true }) });
	const firstPrize = prizes.getByRole('listitem').first();
	await firstPrize.getByText('Video', { exact: true }).click();
	await firstPrize.getByLabel('Video de la biblioteca').selectOption({ label: name });
	await firstPrize.getByRole('button', { name: 'Guardar video' }).click();
	await expect(page.getByRole('status')).toContainText('Video del premio guardado');

	await saveCampaignVideo(page, { url: youtube });

	const visitor = await page.context().newPage();
	await visitor.goto(`/sorteos/${slug}`);
	const embed = visitor.locator('main iframe[src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"]').first();
	await expect(embed).toBeVisible();
	await expect(visitor.locator(`main video source[src$=".mp4"]`).first()).toHaveAttribute('type', 'video/mp4');
	await visitor.goto('/');
	await expect(visitor.locator('main iframe[src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"]').first()).toBeVisible();

	// Leave the campaign and the prize as they were.
	await saveCampaignVideo(page, {});
	await firstPrize.getByText('Video', { exact: true }).click();
	await firstPrize.getByLabel('Video de la biblioteca').selectOption({ label: 'Sin video' });
	await firstPrize.getByRole('button', { name: 'Guardar video' }).click();
	await expect(page.getByRole('status')).toContainText('Video del premio guardado');
	await visitor.goto(`/sorteos/${slug}`);
	await expect(visitor.locator('main video, main iframe[src*="youtube-nocookie.com/embed/dQw4w9WgXcQ"]')).toHaveCount(0);
	await visitor.close();
});

test('only the video upload takes a large body: a 10 MB clip passes, other routes keep 3 MB', async ({ page }) => {
	const name = `largo-${Date.now()}.webm`;
	await signIn(page);
	await uploadVideo(page, name, webm(name + 'x'.repeat(10 * 1024 * 1024)), 'video/webm');

	const big = 'x'.repeat(4 * 1024 * 1024);
	for (const path of ['/carrito?/add', '/admin/sitio?/upload', '/admin/sitio?/save']) {
		const response = await page.request.post(path, { form: { filler: big }, headers: { origin: new URL(page.url()).origin } });
		expect(response.status(), path).toBe(413);
	}
});

test('the large body goes only to the action SvelteKit runs, and only for a session the API verified', async ({ page, browser, baseURL }) => {
	const big = 'x'.repeat(4 * 1024 * 1024);
	const origin = new URL(baseURL!).origin;

	// SvelteKit runs the first `/` key: this is `save`, so it keeps 3 MB even for the owner.
	await signIn(page);
	const smuggled = await page.request.post('/admin/sitio?/save&/uploadVideo', { form: { filler: big }, headers: { origin } });
	expect(smuggled.status()).toBe(413);

	// Without a session, or with a forged token whose expiry looks fine, `handle` refuses before reading the body.
	const claims = Buffer.from(JSON.stringify({ sub: crypto.randomUUID(), email: 'owner@motogarage.local', exp: Math.floor(Date.now() / 1000) + 3600, aal: 'aal2' })).toString('base64url');
	const forged = `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.${claims}.${Buffer.from('not-a-signature').toString('base64url')}`;
	for (const cookie of [null, forged]) {
		const context = await browser.newContext();
		if (cookie) await context.addCookies([{ name: 'sortea_admin_access', value: cookie, url: origin }]);
		const response = await context.request.post('/admin/sitio?/uploadVideo', {
			multipart: { video: { name: 'moto.webm', mimeType: 'video/webm', buffer: webm(big) } },
			headers: { origin },
			maxRedirects: 0
		});
		expect(response.status(), cookie ? 'forged' : 'absent').toBe(401);
		expect(await response.text()).toBe('Iniciá sesión para subir videos');
		await context.close();
	}
});

test.afterAll(async ({ browser }) => {
	const page = await browser.newPage();
	await signIn(page);
	await page.goto('/admin/sitio?tab=imagenes');
	const library = page.getByRole('list', { name: 'Biblioteca' });
	for (const name of await library.locator('.name').allTextContents()) {
		if (!testFile.test(name)) continue;
		const remove = library.getByRole('listitem').filter({ hasText: name }).getByRole('button', { name: 'Borrar' });
		if ((await remove.count()) === 0) continue;
		await remove.click();
		await expect(page.getByRole('status')).toContainText('Video borrado');
	}
	await page.close();
});
